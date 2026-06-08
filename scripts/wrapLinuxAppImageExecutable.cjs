const fs = require('node:fs');
const path = require('node:path');

exports.default = async function wrapLinuxAppImageExecutable(context) {
  if (context.electronPlatformName !== 'linux') {
    return;
  }

  const executableName = context.packager.executableName;
  const executablePath = path.join(context.appOutDir, executableName);
  const realExecutablePath = `${executablePath}.bin`;

  if (fs.existsSync(realExecutablePath)) {
    return;
  }

  if (!fs.existsSync(executablePath)) {
    throw new Error(`Linux executable not found: ${executablePath}`);
  }

  fs.renameSync(executablePath, realExecutablePath);

  const wrapper = `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/${executableName}.bin" --no-sandbox "$@"
`;

  fs.writeFileSync(executablePath, wrapper, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(executablePath, 0o755);
  fs.chmodSync(realExecutablePath, 0o755);
};
