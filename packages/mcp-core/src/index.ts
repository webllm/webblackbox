import { z } from "zod";

export const addNumbersInput = {
  a: z.number().finite().describe("First number"),
  b: z.number().finite().describe("Second number")
};

export type AddNumbersArgs = {
  a: number;
  b: number;
};

export function addNumbers({ a, b }: AddNumbersArgs): number {
  return a + b;
}

export const nowUtcInput = {};

export function nowUtcIsoString(): string {
  return new Date().toISOString();
}

export const echoInput = {
  text: z.string().min(1).max(10_000).describe("Text to echo")
};

export type EchoArgs = {
  text: string;
};

export function echo({ text }: EchoArgs): string {
  return text;
}
