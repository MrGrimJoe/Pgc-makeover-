// Tests and the local database use node:sqlite, which needs Node 22.13 or newer.
// Failing here with a plain message is better than a wall of import errors on every test file.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`This project needs Node 22.13 or newer (you have ${process.versions.node}).`);
  console.error('Install it from https://nodejs.org (the LTS 22 or 24 line) and run the command again.');
  process.exit(1);
}
