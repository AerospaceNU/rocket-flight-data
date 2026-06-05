const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const destination = path.join(projectRoot, 'build', 'bundled-git');

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function gitRootFromExecutable(executable) {
  const normalized = path.normalize(executable);
  const directory = path.dirname(normalized);
  if (path.basename(directory).toLowerCase() === 'cmd') {
    return path.dirname(directory);
  }
  if (path.basename(directory).toLowerCase() === 'bin') {
    return path.dirname(directory);
  }
  return null;
}

function findGitRoot() {
  const candidates = [
    process.env.RFD_GIT_ROOT,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git'),
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Git') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git') : ''
  ].filter(Boolean);
  const whereGit = commandOutput('where', ['git']).split(/\r?\n/).find(Boolean);
  const inferred = whereGit ? gitRootFromExecutable(whereGit) : null;

  if (inferred) {
    candidates.unshift(inferred);
  }

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'cmd', 'git.exe'))) || null;
}

function assertSafeDestination(target) {
  const resolved = path.resolve(target);
  const expectedParent = path.join(projectRoot, 'build');
  if (!resolved.startsWith(`${expectedParent}${path.sep}`)) {
    throw new Error(`Refusing to remove unexpected path: ${resolved}`);
  }
}

function shouldCopy(source) {
  const normalized = source.replace(/\\/g, '/').toLowerCase();
  return ![
    '/doc/',
    '/mingw64/share/doc/',
    '/mingw64/share/locale/',
    '/usr/share/doc/',
    '/usr/share/man/',
    '/usr/share/vim/'
  ].some((segment) => normalized.includes(segment));
}

if (os.platform() !== 'win32') {
  fs.mkdirSync(destination, { recursive: true });
  console.log('Skipping bundled Git staging: only Windows packages need Git for Windows.');
  process.exit(0);
}

const gitRoot = findGitRoot();
if (!gitRoot) {
  throw new Error('Git for Windows was not found. Install Git for Windows or set RFD_GIT_ROOT.');
}

assertSafeDestination(destination);
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(gitRoot, destination, {
  recursive: true,
  filter: (source) => shouldCopy(source)
});

console.log(`Staged bundled Git from ${gitRoot}`);
