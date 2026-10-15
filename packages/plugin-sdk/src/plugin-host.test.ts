import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./plugin-host.js";
import { splitFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("extracts top-level frontmatter keys as a record", () => {
    const md = ["---", "name: foo", "description: a bar", "model: bedrock:x", "---", "", "body"].join(
      "\n",
    );
    const fm = parseFrontmatter(md);
    expect(fm).toMatchObject({ name: "foo", description: "a bar", model: "bedrock:x" });
    expect(fm).not.toHaveProperty("body");
  });

  it("parses YAML lists and nested maps, not just flat scalars", () => {
    const md = [
      "---",
      "name: foo",
      "tools:",
      "  - mcp:a:one",
      "  - mcp:a:two",
      "pizzaBot:",
      "  id: foo",
      '  avatar: "🗂️"',
      "---",
      "",
      "body",
    ].join("\n");
    const fm = parseFrontmatter(md);
    expect(fm.tools).toEqual(["mcp:a:one", "mcp:a:two"]);
    expect(fm.pizzaBot).toEqual({ id: "foo", avatar: "🗂️" });
  });

  it("returns an empty record when there is no frontmatter block", () => {
    expect(parseFrontmatter("# just a heading\n")).toEqual({});
  });

  it("returns an empty record for a malformed frontmatter block", () => {
    expect(parseFrontmatter(["---", "name: [unterminated", "---", "body"].join("\n"))).toEqual({});
  });

  it.each(["\n", "\r\n"])("recovers top-level fields without losing nested YAML with %j newlines", (newline) => {
    const md = [
      "---",
      'name: "review-change"',
      "description: Review changes: report actionable findings.",
      "tools:",
      "  - mcp:github:submit_review",
      "interruptOn:",
      "  mcp:github:submit_review:",
      "    allowedDecisions: [approve, reject]",
      "metadata:",
      "  name: nested-name",
      "---",
      "# Review",
    ].join(newline);

    expect(splitFrontmatter(md)).toMatchObject({
      data: {
        name: "review-change",
        description: "Review changes: report actionable findings.",
        tools: ["mcp:github:submit_review"],
        interruptOn: { "mcp:github:submit_review": { allowedDecisions: ["approve", "reject"] } },
        metadata: { name: "nested-name" },
      },
      body: "# Review",
      error: expect.stringContaining("Nested mappings are not allowed"),
    });
  });

  it("does not treat nested names as top-level names during fallback", () => {
    const md = "---\nmetadata:\n  name: nested-name\ndescription: Review changes: carefully.\n---\n# Review";
    expect(parseFrontmatter(md)).toEqual({
      metadata: { name: "nested-name" },
      description: "Review changes: carefully.",
    });
  });
});
