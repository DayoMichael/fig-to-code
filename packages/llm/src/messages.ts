import type { PromptEnvelope } from "@fig2code/spec";

export function envelopeToMessages(
  envelope: PromptEnvelope,
): Array<{ role: string; content: string }> {
  const system = envelope.slots.filter(
    (slot) => slot.id === "system_core" || slot.id === "output_contract",
  );
  const user = envelope.slots.filter(
    (slot) => slot.id !== "system_core" && slot.id !== "output_contract",
  );

  return [
    {
      role: "system",
      content: system.map((slot) => `## ${slot.id}\n${slot.content}`).join("\n\n"),
    },
    {
      role: "user",
      content: user.map((slot) => `## ${slot.id}\n${slot.content}`).join("\n\n"),
    },
  ];
}
