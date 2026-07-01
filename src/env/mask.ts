// Secret values must never appear in normal terminal output, diffs, or logs.
// maskSecret renders a fixed-width placeholder so a preview shows *that* a value
// exists (or is empty) without revealing its length or content.
export function maskSecret(value: string): string {
  if (value === "") {
    return "<empty>";
  }

  return "********";
}
