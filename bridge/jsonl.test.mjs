import test from "node:test";
import assert from "node:assert/strict";
import { StrictJsonlDecoder } from "./jsonl.mjs";

test("strict JSONL accepts chunk boundaries and CRLF input", () => {
  const decoder = new StrictJsonlDecoder();
  assert.deepEqual(decoder.push('{"text":"a\\nU+2028"}\n{"n":'), [{text:"a\nU+2028"}]);
  assert.deepEqual(decoder.push('1}\r\n'), [{n:1}]);
});

test("records without LF remain buffered", () => {
  const decoder = new StrictJsonlDecoder();
  assert.deepEqual(decoder.push('{"n":1}'), []);
  assert.deepEqual(decoder.push('\n'), [{n:1}]);
});
