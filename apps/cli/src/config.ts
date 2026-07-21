import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ClientConfig {
  apiBaseUrl: string;
  sessionToken?: string;
  activeOrganizationId?: string;
  activeChannelByOrganization: Record<string, string>;
  downloadDirectory: string;
}

function configPath(): string {
  const root = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(root, "ziloteams", "config.json");
}

export class ConfigStore {
  readonly path = configPath();

  async load(defaultApiBaseUrl: string): Promise<ClientConfig> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const value = parsed as Partial<ClientConfig>;
        return {
          apiBaseUrl: typeof value.apiBaseUrl === "string" ? value.apiBaseUrl : defaultApiBaseUrl,
          sessionToken: typeof value.sessionToken === "string" ? value.sessionToken : undefined,
          activeOrganizationId: typeof value.activeOrganizationId === "string" ? value.activeOrganizationId : undefined,
          activeChannelByOrganization: value.activeChannelByOrganization && typeof value.activeChannelByOrganization === "object"
            ? value.activeChannelByOrganization : {},
          downloadDirectory: typeof value.downloadDirectory === "string" ? value.downloadDirectory : join(homedir(), "Downloads")
        };
      }
    } catch {
      // Missing or invalid configuration is treated as first run.
    }
    return {
      apiBaseUrl: defaultApiBaseUrl,
      activeChannelByOrganization: {},
      downloadDirectory: join(homedir(), "Downloads")
    };
  }

  async save(config: ClientConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  async clearSession(config: ClientConfig): Promise<void> {
    delete config.sessionToken;
    delete config.activeOrganizationId;
    config.activeChannelByOrganization = {};
    await this.save(config);
  }
}
