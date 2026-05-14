import { createNodeRuntime } from "./env";
import { listEnabledInspirationSources } from "../worker/inspiration";

const runtime = createNodeRuntime();

try {
  if (runtime.env.INSPIRATION_FEATURE_ENABLED === "true") {
    const sources = await listEnabledInspirationSources(runtime.env.DB);
    const results = await Promise.allSettled(
      sources.map((source) =>
        runtime.env.INSPIRATION_QUEUE.send({
          type: "inspiration-source",
          sourceId: source.id,
          trigger: "scheduled",
        }),
      ),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    console.log(`scheduled inspiration enqueue completed: ${sources.length - failed}/${sources.length}`);
    if (failed > 0) process.exitCode = 1;
  } else {
    console.log("inspiration cron skipped: INSPIRATION_FEATURE_ENABLED is not true");
  }
} finally {
  await runtime.close();
}
