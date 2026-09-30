import type { MixturePreset } from "../mixture-of-agents.js";

export const MIXTURE_USAGE = "Usage: /moa <duo|trio|quartet> <provider>... --aggregate <provider> -- <question>.";

export type InteractiveMixtureCommand = {
  preset: MixturePreset;
  providers: string[];
  aggregator: string;
  question: string;
};

/** Only explicit registered provider IDs; the profile supplies exact configured models. */
export function parseInteractiveMixtureCommand(input: string, available: readonly string[]): InteractiveMixtureCommand | undefined {
  const marker = input.indexOf(" -- ");
  if (marker < 0) return undefined;
  const fields = input.slice(0, marker).split(/\s+/u);
  const question = input.slice(marker + 4).trim();
  const preset = fields[1];
  const count = preset === "duo" ? 2 : preset === "trio" ? 3 : preset === "quartet" ? 4 : 0;
  if (fields[0] !== "/moa" || !count || fields.length !== count + 4
    || fields[count + 2] !== "--aggregate" || !question || question.length > 4_000
    || /[\u0000-\u001f\u007f]/u.test(question)) return undefined;
  const providers = fields.slice(2, 2 + count);
  const aggregator = fields[count + 3]!;
  if (new Set(providers).size !== count || ![...providers, aggregator].every((provider) => available.includes(provider))) return undefined;
  return { preset: preset as MixturePreset, providers, aggregator, question };
}
