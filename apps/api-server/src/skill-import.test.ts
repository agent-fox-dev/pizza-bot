import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_UPLOAD_BYTES,
  SkillImportError,
  parseSkillArchive,
  parseSkillImport,
} from "./skill-import.js";
import { storedZip as zip } from "./test-utils/stored-zip.js";

describe("parseSkillArchive", () => {
  it("imports a spec-shaped skill directory and preserves every file", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const archive = zip([
      {
        path: "review-change/SKILL.md",
        content: [
          "---",
          "name: review-change",
          "description: Review a code change and report actionable findings.",
          "license: Apache-2.0",
          "---",
          "",
          "# Review change",
          "",
          "Inspect the diff and report findings.",
          "",
        ].join("\n"),
      },
      { path: "review-change/references/checklist.md", content: "# Checklist\n" },
      { path: "review-change/assets/icon.png", content: png },
    ]);

    const skill = await parseSkillArchive(archive);
    assertSkill(skill);

    expect(skill).toMatchObject({
      id: "review-change",
      name: "review-change",
      description: "Review a code change and report actionable findings.",
      body: "# Review change\n\nInspect the diff and report findings.\n",
    });
    expect(skill.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "assets/icon.png",
      "references/checklist.md",
    ]);
    expect(skill.files[0]!.content).toEqual(
      new TextEncoder().encode([
        "---",
        "name: review-change",
        "description: Review a code change and report actionable findings.",
        "license: Apache-2.0",
        "---",
        "",
        "# Review change",
        "",
        "Inspect the diff and report findings.",
        "",
      ].join("\n")),
    );
    expect(skill.files[1]!.content).toEqual(png);
  });

  it("accepts SKILL.md at archive root and uses its name as the custom skill id", async () => {
    const skill = await parseSkillArchive(zip([
      {
        path: "SKILL.md",
        content: "---\nname: root-skill\ndescription: A root skill.\n---\n\n# Instructions\n",
      },
    ]));
    assertSkill(skill);

    expect(skill.id).toBe("root-skill");
  });

  it.each([
    {
      label: "missing SKILL.md",
      files: [{ path: "review-change/reference.md", content: "none" }],
      code: "invalid_bundle",
    },
    {
      label: "directory mismatch",
      files: [{
        path: "wrong/SKILL.md",
        content: "---\nname: review-change\ndescription: Reviews changes.\n---\n\n# Review\n",
      }],
      code: "name_mismatch",
    },
    {
      label: "non-spec name",
      files: [{
        path: "SKILL.md",
        content: "---\nname: Review_Change\ndescription: Reviews changes.\n---\n\n# Review\n",
      }],
      code: "invalid_skill_name",
    },
    {
      label: "empty instructions",
      files: [{
        path: "review-change/SKILL.md",
        content: "---\nname: review-change\ndescription: Reviews changes.\n---\n",
      }],
      code: "invalid_skill_md",
    },
  ])("rejects $label", async ({ files, code }) => {
    await expect(parseSkillArchive(zip(files))).resolves.toMatchObject({ code });
  });

  it("rejects traversal entries before reading their content", async () => {
    await expect(parseSkillArchive(zip([
      { path: "../SKILL.md", content: "unsafe" },
    ]))).resolves.toMatchObject({ code: "unsafe_path" });
  });

  it("rejects control characters in skill paths", async () => {
    await expect(parseSkillArchive(zip([
      {
        path: "review-\tchange/SKILL.md",
        content: "---\nname: review-change\ndescription: Reviews changes.\n---\n\n# Review\n",
      },
    ]))).resolves.toMatchObject({ code: "unsafe_path" });
  });

  it("rejects case-insensitive duplicate file paths", async () => {
    await expect(parseSkillArchive(zip([
      {
        path: "review-change/SKILL.md",
        content: "---\nname: review-change\ndescription: Reviews changes.\n---\n\n# Review\n",
      },
      { path: "review-change/Notes.md", content: "one" },
      { path: "review-change/notes.md", content: "two" },
    ]))).resolves.toMatchObject({ code: "duplicate_entry" });
  });

  it("rejects inconsistent ZIP size metadata as a malformed archive", async () => {
    const archive = zip([
      {
        path: "SKILL.md",
        content: "---\nname: review-change\ndescription: Reviews changes.\n---\n\n# Review\n",
        declaredSize: 1024,
      },
    ]);

    await expect(parseSkillArchive(archive)).resolves.toBeInstanceOf(SkillImportError);
    await expect(parseSkillArchive(archive)).resolves.toMatchObject({ code: "invalid_archive" });
  });
});

function assertSkill(
  skill: Awaited<ReturnType<typeof parseSkillImport>>,
): asserts skill is Exclude<typeof skill, SkillImportError> {
  expect(skill).not.toBeInstanceOf(SkillImportError);
}

const markdown = [
  "---",
  "name: review-change",
  "description: Review a code change.",
  "license: Apache-2.0",
  "tools:",
  "  - mcp:github:submit_review",
  "interruptOn:",
  "  mcp:github:submit_review:",
  "    allowedDecisions: [approve, reject]",
  "---",
  "",
  "# Review",
  "",
  "Inspect the diff.",
  "",
].join("\r\n");

describe("parseSkillImport", () => {
  it.each(["SKILL.md", "a-different-name.md", "REVIEW.MD"])(
    "imports %s using its frontmatter name and preserves the original bytes",
    async (filename) => {
      const bytes = new TextEncoder().encode(markdown);
      const skill = await parseSkillImport(filename, bytes);

      expect(skill).toMatchObject({
        id: "review-change",
        name: "review-change",
        description: "Review a code change.",
        body: "# Review\r\n\r\nInspect the diff.\r\n",
        declaredTools: ["mcp:github:submit_review"],
        interruptOn: { "mcp:github:submit_review": { allowedDecisions: ["approve", "reject"] } },
        files: [{ path: "SKILL.md", content: bytes }],
      });
    },
  );

  it.each(["review.zip", "REVIEW.ZIP", "download", "review.md"])(
    "detects ZIP content in %s and preserves sibling files",
    async (filename) => {
      const skill = await parseSkillImport(filename, zip([
        { path: "SKILL.md", content: markdown },
        { path: "references/checklist.md", content: "# Checklist" },
      ]));
      assertSkill(skill);

      expect(skill.id).toBe("review-change");
      expect(skill.files).toEqual([
        { path: "SKILL.md", content: new TextEncoder().encode(markdown) },
        { path: "references/checklist.md", content: new TextEncoder().encode("# Checklist") },
      ]);
    },
  );

  it.each([
    { content: "", code: "invalid_skill_md" },
    { content: "# Instructions without frontmatter", code: "invalid_skill_md" },
    { content: "---\nname: [invalid\n---\n# Review", code: "invalid_skill_md" },
    { content: markdown.replace("name: review-change\r\n", ""), code: "invalid_skill_md" },
    { content: markdown.replace("description: Review a code change.\r\n", ""), code: "invalid_skill_md" },
    { content: markdown.replace("name: review-change", "name: Review_Change"), code: "invalid_skill_name" },
    { content: "---\nname: review-change\ndescription: Review changes.\n---\n", code: "invalid_skill_md" },
  ])("rejects invalid Markdown with $code", async ({ content, code }) => {
    await expect(parseSkillImport("skill.md", new TextEncoder().encode(content)))
      .resolves.toMatchObject({ code });
  });

  it("rejects invalid UTF-8", async () => {
    await expect(parseSkillImport("skill.md", new Uint8Array([0xff])))
      .resolves.toMatchObject({ code: "invalid_skill_md", message: "SKILL.md must be valid UTF-8 text." });
  });

  it("reports a broken ZIP without falling back to Markdown", async () => {
    await expect(parseSkillImport("skill.zip", new TextEncoder().encode(markdown)))
      .resolves.toMatchObject({ code: "invalid_archive" });
  });

  it("rejects unsupported files", async () => {
    await expect(parseSkillImport("skill.txt", new TextEncoder().encode(markdown)))
      .resolves.toMatchObject({ code: "unsupported_file" });
  });

  it.each(["skill.md", "skill.zip"])("rejects oversized %s uploads", async (filename) => {
    await expect(parseSkillImport(filename, new Uint8Array(MAX_SKILL_UPLOAD_BYTES + 1)))
      .resolves.toMatchObject({ code: "file_too_large" });
  });
});
