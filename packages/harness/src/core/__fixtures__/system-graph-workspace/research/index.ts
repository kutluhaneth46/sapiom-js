export async function research(ctx: { sapiom: { agents: { launch: Function } } }) {
  return ctx.sapiom.agents.launch({ definition: "growth", input: { topic: "market" } });
}
