// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Watchman cannot watch this project from the SMB-mounted NAS at /Volumes/Projects:
// its cookie handshake times out ("syncToNow: timed out waiting for cookie file to
// be observed by watcher"), which leaves Metro either serving stale modules — edits
// to already-bundled files silently never reach the device — or crashing outright
// in node-haste/DependencyGraph with a half-built haste map.
//
// Metro's own node crawler is slower to start but correct here. Remove this if the
// project ever moves to local disk.
config.resolver.useWatchman = false;

module.exports = config;
