import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cwd = process.cwd();

describe("scripts/push-dev.sh", () => {
  it("prints the standard dev deployment flow in dry-run mode", () => {
    const output = execFileSync("bash", ["scripts/push-dev.sh"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        DRY_RUN: "1",
        RELEASE_NAME: "dev-20260617150000",
      },
    });

    expect(output).toContain("tar -czf oh-myimage-dev-release.tar.gz");
    expect(output).toContain("dist-node");
    expect(output).toContain("mkdir -p /opt/oh-myimage-dev/releases/dev-20260617150000");
    expect(output).toContain("ln -sfn /opt/oh-myimage-dev/releases/dev-20260617150000 /opt/oh-myimage-dev/current");
    expect(output).toContain("npm run db:migrate:postgres");
    expect(output).toContain("--force-recreate oh-myimage-dev-api oh-myimage-dev-worker");
    expect(output).toContain("curl -s https://dev-gen.fourj.space/api/config");
    expect(output).toContain("https://dev-gen.fourj.space/?preview=off");
  });
});
