import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A position in a workspace file: `line` is 1-based, `character` a 0-based UTF-16 offset. */
export const CodeDefinitionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString,
  line: PositiveInt,
  character: NonNegativeInt,
  /** The name at the position; a file edited since the view rendered is answered as `stale`. */
  name: TrimmedNonEmptyString,
});
export type CodeDefinitionInput = typeof CodeDefinitionInput.Type;

export const CodeDefinitionLocation = Schema.Struct({
  /** Relative to `cwd` when inside it, otherwise absolute. */
  path: TrimmedNonEmptyString,
  lineNumber: PositiveInt,
  lineContent: Schema.String,
});
export type CodeDefinitionLocation = typeof CodeDefinitionLocation.Type;

export const CodeDefinitionResult = Schema.Struct({
  /**
   * `unsupported`: no language server for this file type is installed. `stale`: the file no longer
   * has the name at that position. Clients fall back to text search for both.
   */
  status: Schema.Literals(["ok", "unsupported", "stale"]),
  locations: Schema.Array(CodeDefinitionLocation),
  server: Schema.optional(TrimmedNonEmptyString),
  /** The language server is still indexing the workspace; asking again can find more. */
  partial: Schema.optional(Schema.Boolean),
});
export type CodeDefinitionResult = typeof CodeDefinitionResult.Type;

export class CodeDefinitionError extends Schema.TaggedError<CodeDefinitionError>()(
  "CodeDefinitionError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
