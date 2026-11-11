import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { defineRunnerPlugin, getRunner } from '@moruteaven/matchabuild';
import { ensureDir, log } from '@moruteaven/matchabuild/utils';

const run = promisify(execFile);

function resolveTauriCli(clientDir) {
  const require = createRequire(path.join(clientDir, 'package.json'));
  try {
    const pkgPath = require.resolve('@tauri-apps/cli/package.json');
    const pkg = require(pkgPath);
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tauri;
    if (!bin) return null;
    return path.join(path.dirname(pkgPath), bin);
  } catch {
    return null;
  }
}

export default defineRunnerPlugin({
  id: 'tauri',

  async preflight(target) {
    const tauriDir = path.join(target.dirAbs, 'src-tauri');
    if (!existsSync(tauriDir)) {
      throw new Error(`缺少 src-tauri 目录：${path.relative(target.dirAbs, tauriDir)}`);
    }
    return { tauriDir };
  },

  async build(target, ctx) {
    // 1) 前端产物：复用内核内置的 vite runner，产物落在 target.outDir
    const front = await getRunner('vite').build(target, ctx);

    // 2) Rust 打包：缺 CLI 时只交付前端资源，并给出明确提示
    const cli = resolveTauriCli(target.dirAbs);
    if (!cli) {
      log.warn('未安装 @tauri-apps/cli，只产出前端资源；安装后可用 matcha build 出安装包');
      return { ...front, runner: 'tauri' };
    }

    const bundleDir = path.join(target.outDirAbs, 'bundle');
    await ensureDir(bundleDir);
    const args = ['build', '--config', path.join(target.dirAbs, 'src-tauri', 'tauri.conf.json')];
    for (const bundle of target.bundle ?? []) args.push('--bundles', bundle);

    log.step('tauri build（Rust 编译较慢）');
    try {
      await run(process.execPath, [cli, ...args], {
        cwd: target.dirAbs,
        env: { ...process.env },
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      const detail = [error.stdout, error.stderr]
        .map((chunk) =>
          String(chunk ?? '')
            .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .slice(-40)
            .join('\n'),
        )
        .filter(Boolean)
        .join('\n');
      throw new Error(`tauri build 失败：\n${detail || error.message}`);
    }
    return { ...front, runner: 'tauri', bundleDir };
  },

  async dev(target) {
    const cli = resolveTauriCli(target.dirAbs);
    if (!cli) throw new Error('找不到 @tauri-apps/cli（tauri 依赖未安装）');
    await run(process.execPath, [cli, 'dev'], { cwd: target.dirAbs, env: { ...process.env } });
  },
});
