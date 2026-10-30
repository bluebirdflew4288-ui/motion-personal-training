export function motionProjectKey(androidDir: string): string;
export function stripAppleDouble(root: string): number;
export function resolveAndroidSdk(
  env?: Record<string, string | undefined>,
  existsFn?: (p: string) => boolean,
): { ok: boolean; error?: string; path?: string };
export function validateStaticAssets(params: {
  builtHtml?: string;
  packedHtml?: string;
  capacitorConfigContent?: string;
}): {
  ok: boolean;
  errors: string[];
  builtScript: string | null;
  packedScript: string | null;
};
export function runPreflightGate(options?: {
  env?: Record<string, string | undefined>;
  existsFn?: (p: string) => boolean;
  runFn?: (cmd: string, args: string[], opts?: any) => any;
}): { sdk?: string };
export function executeAndroidBuild(options?: any): void;
