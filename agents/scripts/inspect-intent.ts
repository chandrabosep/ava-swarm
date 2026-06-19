// Print status + payload for one or more intent ids.
//   npx tsx --env-file=.env scripts/inspect-intent.ts <id> [<id>...]

import { PrismaClient } from '@prisma/client';

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error('usage: inspect-intent.ts <id> [<id>...]');
    process.exit(2);
  }
  const db = new PrismaClient();
  const rows = await db.intent.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      fromAgent: true,
      payload: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  for (const r of rows) {
    console.log(JSON.stringify(r, null, 2));
  }
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    for (const id of ids) {
      if (!found.has(id)) console.log(`(not found: ${id})`);
    }
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
