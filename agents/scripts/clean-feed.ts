// Clear the legacy DeFi-rebalance swap pipeline's telemetry so the dashboard
// feed shows only the Speedrun story (x402 hires + ERC-8004 + delegations).
//
// KEEPS:  Event kind 'x402.hire' (the demo) and 'session.granted' (user
//         delegations). Deletes all swap Intents + swap-pipeline events.
//
// Dry-run by default — prints what it WOULD delete. Pass --apply to delete.
//   npx tsx --env-file=.env scripts/clean-feed.ts          # dry-run
//   npx tsx --env-file=.env scripts/clean-feed.ts --apply   # delete

const KEEP_EVENT_KINDS = ['x402.hire', 'session.granted'];

async function main() {
  const apply = process.argv.includes('--apply');
  const { db } = await import('@swarm/shared');
  const d = db();

  const intentCount = await d.intent.count();
  const eventsToDelete = await d.event.count({
    where: { kind: { notIn: KEEP_EVENT_KINDS } },
  });
  const eventsKept = await d.event.count({
    where: { kind: { in: KEEP_EVENT_KINDS } },
  });

  console.log(`Intents to delete:        ${intentCount}`);
  console.log(`Pipeline events to delete: ${eventsToDelete}`);
  console.log(`Events kept (hire+grants): ${eventsKept}`);

  if (!apply) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --apply to delete.');
    process.exit(0);
  }

  const di = await d.intent.deleteMany({});
  const de = await d.event.deleteMany({
    where: { kind: { notIn: KEEP_EVENT_KINDS } },
  });
  console.log(`\n✅ Deleted ${di.count} intents and ${de.count} pipeline events.`);
  console.log(`   Feed now shows only ${eventsKept} hire/delegation events.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
