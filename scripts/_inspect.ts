import { db } from "../lib/db";
async function main() {
  for (const id of ["cmprhq87", "cmprbx0t"]) {
    const run = await db.aiRun.findFirst({ where: { id: { startsWith: id } }, select: { id: true, instruction: true } });
    if (!run) { console.log(id, "not found"); continue; }
    console.log(`\n=== RUN ${run.id} :: ${JSON.stringify(run.instruction)}`);
    const events = await db.aiRunEvent.findMany({
      where: { aiRunId: run.id }, orderBy: { createdAt: "asc" },
      select: { role: true, message: true },
    });
    for (const e of events) console.log(`  [${e.role}] ${String(e.message).replace(/\n/g, "\\n").slice(0, 240)}`);
  }
}
main().finally(() => db.$disconnect());
