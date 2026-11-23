import { it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import ts from "typescript";
import { implementsMethod } from "../src/core/client-support.js";

it("shipped source has no non-null assertions", async () => {
  // AGENTS.md: prove types with a guard or decoder. The anti-slop assertion rule inspects
  // `as` and angle-bracket casts only, so this test covers `value!`.
  const src = new URL("../src/", import.meta.url);
  const found: string[] = [];

  for (const entry of await readdir(src, { recursive: true })) {
    if (!entry.endsWith(".ts")) continue;

    const file = ts.createSourceFile(
      entry,
      await readFile(new URL(entry, src), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isNonNullExpression(node)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        found.push(`${entry}:${line + 1} ${node.getText(file)}`);
      }

      ts.forEachChild(node, visit);
    };

    visit(file);
  }

  assert.deepEqual(found, []);
});

it("implementsMethod narrows only when the surface and its method are present", () => {
  interface Posts {
    readonly prefix: string;
    get?(id: string): string;
  }

  const withGet: Posts = {
    prefix: "post:",
    get(id) {
      return `${this.prefix}${id}`;
    },
  };

  const withoutGet: Posts = { prefix: "post:" };
  const lookup = (found: boolean): Posts | undefined => (found ? withGet : undefined);

  assert.equal(implementsMethod(withoutGet, "get"), false);
  assert.equal(implementsMethod(lookup(false), "get"), false);
  assert.ok(implementsMethod(withGet, "get"));

  // The method is called on its owner, so `this` still resolves.
  const call = () => withGet.get("1");
  assert.equal(call(), "post:1");
});
