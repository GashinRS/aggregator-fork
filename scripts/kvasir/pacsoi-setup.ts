import { createPolicies } from "./policies.js";
import { KvasirManagement } from "./management.js";
import { config, aliceUmaId, clientUmaId } from "../config.js";
import readline from "readline";

const POD_URL = `${config.kvasirServer}/alice`;

const kvasir = new KvasirManagement(POD_URL, config.asServer);
await kvasir.init(config.idp, config.realm);
await kvasir.login(config.alice.username, config.alice.password, config.clientId, config.clientSecret);

async function main() {
  const policyIds: string[] = [];
  const slices: Record<string, string> = {};

  try {
    console.log("\u25b6 Delegating pod access control to UMA");
    await kvasir.delegatePodToUMA();

    console.log("\u25b6 Creating slice-management policy for owner\u2026");
    const { turtle: ownerPolicyTurtle, ids: ownerPolicyIds } = await createPolicies([
      {
        name: "owner_slice_management",
        assignee: aliceUmaId,
        assigner: aliceUmaId,
        scopes: ["read", "write", "delete"],
        target: POD_URL + "/slices",
        client: clientUmaId,
      },
    ]);
    policyIds.push(...ownerPolicyIds);
    await kvasir.registerPolicies(ownerPolicyTurtle);

    console.log("\u25b6 Registering new slice\u2026");
    const slice = await kvasir.registerSlice(
      config.context,
      config.schema,
      "AggregatorDemoSlice",
      "Slice for aggregator demo"
    );
    slices["AggregatorDemoSlice"] = slice;
    console.log(`   \u279d Slice created: ${slice}`);

    console.log("\u25b6 Granting owner access to slice\u2026");
    const { turtle: slicePolicyTurtle, ids: slicePolicyIds } = await createPolicies([
      { name: "SlicesOwnerDelete",              assignee: aliceUmaId, assigner: aliceUmaId, target: slice,               scopes: ["delete"] },
      { name: "AggregatorDemoSliceOwnerQuery",  assignee: aliceUmaId, assigner: aliceUmaId, target: `${slice}/query`,   scopes: ["read", "write"] },
      { name: "AggregatorDemoSliceOwnerChanges",assignee: aliceUmaId, assigner: aliceUmaId, target: `${slice}/changes`, scopes: ["read", "write"] },
    ]);
    policyIds.push(...slicePolicyIds);
    await kvasir.registerPolicies(slicePolicyTurtle);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("\u25b6 Setup complete. Press ENTER to add an observation, Ctrl+C to exit.\n");

    rl.on("line", async () => {
      try {
        const observation = generateObservation();
        await kvasir.addData(slice, config.context, [observation]);
        console.log(`   \u279d Added observation ${observation.id}`);
        console.log("Press ENTER to add another observation\u2026");
      } catch (err) {
        console.error("   \u274c Failed to add observation:", err);
      }
    });

    await waitForExitSignal();
    rl.close();
  } catch (err) {
    console.error("\u274c Error during setup:", err);
  } finally {
    console.log("\u25b6 Waiting to clean up setup (Ctrl+C)\u2026\n");
    await waitForExitSignal();
    console.log("\n\u23f3 Cleaning up setup\u2026");

    for (const slice of Object.values(slices)) {
      try {
        console.log(`   \u279d Deleting slice: ${slice}`);
        await kvasir.deleteSlice(slice);
      } catch (err) {
        console.error(`   \u274c Failed to delete slice:`, err);
      }
    }

    try {
      console.log("   \u279d Deleting policies\u2026");
      await kvasir.deletePolicies(policyIds);
    } catch (err) {
      console.error("   \u274c Failed to delete policies:", err);
    }

    console.log("\u2714 Cleanup complete. Exiting.");
  }
}

main().catch(err => { console.error("\u274c Fatal error:", err); process.exit(1); });

function waitForExitSignal(): Promise<void> {
  return new Promise(resolve => {
    const interval = setInterval(() => {}, 1 << 30);
    const handler = () => { clearInterval(interval); process.off("SIGINT", handler); process.off("SIGTERM", handler); resolve(); };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  });
}

type KvasirValue = string | number | boolean | null | { [key: string]: KvasirValue };
type KvasirInsert = Record<string, KvasirValue>;

function generateObservation(): KvasirInsert {
  const randomValue = Math.floor(Math.random() * (100 - 60 + 1)) + 60;
  const obsId = `ex:Observation${crypto.randomUUID()}`;
  return {
    "@type": "ex:Patient",
    id: aliceUmaId,
    ex_hasObservation: {
      "@type": "ex:Observation",
      id: obsId,
      ex_value: randomValue,
      ex_unit: "kg",
      ex_timestamp: { "@type": "http://www.w3.org/2001/XMLSchema#dateTime", "@value": new Date().toISOString() },
    },
  };
}
