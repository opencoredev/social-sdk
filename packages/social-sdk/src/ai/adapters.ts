import { definedFields } from "../core/fields.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { isJsonValue } from "../transport/json.js";
import { isJsonObject } from "../transport/validation.js";
import type {
  SocialToolCallOptions,
  SocialToolDefinition,
  SocialToolkit,
  SocialToolResult,
} from "./toolkit.js";

/** OpenAI Chat Completions `tools` entry. */
export type OpenAIChatTool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonObject;
  };
};

/** OpenAI Responses API `tools` entry. */
export type OpenAIResponsesTool = {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  /** Strict mode requires every property to be required, which these schemas do not follow. */
  readonly strict: false;
};

export function toOpenAIChatTools(toolkit: SocialToolkit): readonly OpenAIChatTool[] {
  return toolkit.tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

export function toOpenAIResponsesTools(toolkit: SocialToolkit): readonly OpenAIResponsesTool[] {
  return toolkit.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
}

/**
 * Run one OpenAI function call. `arguments` is the JSON text the model
 * produced; the return value is the JSON text to send back as the tool output.
 */
export async function runOpenAIToolCall(
  toolkit: SocialToolkit,
  call: { readonly name: string; readonly arguments: string },
  options?: SocialToolCallOptions,
): Promise<string> {
  const args = parseArguments(call.arguments);

  if (args === undefined)
    return JSON.stringify({
      ok: false,
      tool: call.name,
      error: { code: "invalid_input", message: "Tool arguments must be JSON text." },
    } satisfies SocialToolResult);

  return JSON.stringify(await toolkit.call(call.name, args, options));
}

function parseArguments(text: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(text === "" ? "{}" : text);

    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type StandardIssue = { readonly message: string; readonly path?: readonly string[] };

type StandardResult =
  | { readonly value: JsonObject; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };

type JsonSchemaConverter = {
  readonly input: (options: { readonly target: string }) => JsonObject;
  readonly output: (options: { readonly target: string }) => JsonObject;
};

/**
 * A Standard Schema (https://standardschema.dev) with its JSON Schema
 * converter, so schema-aware SDKs accept the tool input without an adapter
 * package. Validation only proves the input is a JSON object; the toolkit
 * decodes each field when the tool runs.
 */
export type SocialStandardSchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "social-sdk";
    readonly validate: <Input>(value: Input) => StandardResult;
    readonly jsonSchema: JsonSchemaConverter;
    readonly types?: { readonly input: JsonObject; readonly output: JsonObject };
  };
};

export function toStandardSchema(tool: SocialToolDefinition): SocialStandardSchema {
  const schema = () => tool.inputSchema;

  return {
    "~standard": {
      version: 1,
      vendor: "social-sdk",
      validate: (value) =>
        isJsonValue(value) && isJsonObject(value)
          ? { value }
          : { issues: [{ message: "Tool input must be a JSON object." }] },
      jsonSchema: { input: schema, output: schema },
    },
  };
}

/** A tool in the shape the Vercel AI SDK `tools` option accepts. */
export type SocialAISDKTool = {
  readonly title: string;
  readonly description: string;
  readonly inputSchema: SocialStandardSchema;
  readonly execute: (
    input: JsonObject,
    execution: { readonly abortSignal?: AbortSignal },
  ) => Promise<SocialToolResult>;
};

/**
 * Tools for the Vercel AI SDK (`generateText({ tools })`). The model's abort
 * signal is forwarded to each call; `options.authorization` scopes every call.
 */
export function toAISDKTools(
  toolkit: SocialToolkit,
  options: Pick<SocialToolCallOptions, "authorization"> = {},
): { readonly [name: string]: SocialAISDKTool } {
  return Object.fromEntries(
    toolkit.tools.map((tool) => [
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toStandardSchema(tool),
        execute: (input, execution) =>
          toolkit.call(tool.name, input, {
            ...options,
            ...definedFields({ signal: execution.abortSignal }),
          }),
      } satisfies SocialAISDKTool,
    ]),
  );
}
