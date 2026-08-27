export async function research(ctx: {
  sapiom: { agents: { run: Function; launch: Function } };
}) {
  await ctx.sapiom.agents.run({
    definition: "growth",
    input: { topic: "market" },
  });
  return ctx.sapiom.agents.launch({
    definition: "growth",
    input: { topic: "market" },
  });
}
