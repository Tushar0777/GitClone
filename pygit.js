#!/usr/bin/env node
/*
  PyGit -> JS conversion
  Single-file minimal Git clone in Node.js

  Usage: node pygit.js <command> [args]
  Commands: init, add, commit, checkout, branch, log, status

  This file mirrors the Python implementation you provided with similar
  behavior and caveats. It's intentionally straightforward and readable.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

function ensureDirSync(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

class GitObject {
  constructor(type, content) {
    this.type = type;
    this.content = content; // Buffer
  }

  hash() {
    const header = Buffer.from(`${this.type} ${this.content.length}\0`);
    const store = Buffer.concat([header, this.content]);
    return crypto.createHash('sha1').update(store).digest('hex');
  }

  serialize() {
    const header = Buffer.from(`${this.type} ${this.content.length}\0`);
    const store = Buffer.concat([header, this.content]);
    return zlib.deflateSync(store);
  }

  static deserialize(data) {
    const decompressed = zlib.inflateSync(data);
    const nullIdx = decompressed.indexOf(0);
    const header = decompressed.slice(0, nullIdx).toString();
    const content = decompressed.slice(nullIdx + 1);
    const [type] = header.split(' ');
    return new GitObject(type, content);
  }
}

class Blob extends GitObject {
  constructor(content) {
    super('blob', Buffer.from(content));
  }
}

class Tree extends GitObject {
  // entries: [{mode, name, hashHex}]
  constructor(entries = []) {
    super('tree', Buffer.alloc(0));
    this.entries = entries;
    this.content = this._serializeEntries();
  }

  _serializeEntries() {
    // Sort by name for stability
    const sorted = [...this.entries].sort((a, b) => {
      return Buffer.from(a.name, 'utf8').compare(Buffer.from(b.name, 'utf8'));
    });
    const parts = [];
    for (const e of sorted) {
      const header = Buffer.from(`${e.mode} ${e.name}\0`);
      const hashRaw = Buffer.from(e.hashHex, 'hex');
      parts.push(header, hashRaw);
    }
    return Buffer.concat(parts);
  }

  addEntry(mode, name, hashHex) {
    this.entries.push({ mode, name, hashHex });
    this.content = this._serializeEntries();
  }

  static fromContent(content) {
    const tree = new Tree();
    let i = 0;
    while (i < content.length) {
      const nullIdx = content.indexOf(0, i);
      if (nullIdx === -1) break;
      const modeName = content.slice(i, nullIdx).toString();
      const [mode, name] = modeName.split(' ', 2);
      const objHash = content.slice(nullIdx + 1, nullIdx + 21).toString('hex');
      tree.entries.push({ mode, name, hashHex: objHash });
      i = nullIdx + 21;
    }
    tree.content = content;
    return tree;
  }
}

class Commit extends GitObject {
  constructor(treeHash, parentHashes, author, committer, message, timestamp = null) {
    // build content
    const ts = timestamp || Math.floor(Date.now() / 1000);
    const lines = [];
    lines.push(`tree ${treeHash}`);
    for (const p of parentHashes) lines.push(`parent ${p}`);
    lines.push(`author ${author} ${ts} +0000`);
    lines.push(`committer ${committer} ${ts} +0000`);
    lines.push('');
    lines.push(message);
    const content = Buffer.from(lines.join('\n'));
    super('commit', content);

    this.treeHash = treeHash;
    this.parentHashes = parentHashes;
    this.author = author;
    this.committer = committer;
    this.message = message;
    this.timestamp = ts;
  }

  static fromContent(content) {
    const lines = content.toString().split('\n');
    let treeHash = null;
    const parentHashes = [];
    let author = null;
    let committer = null;
    let messageStart = 0;
    let timestamp = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('tree ')) treeHash = line.slice(5);
      else if (line.startsWith('parent ')) parentHashes.push(line.slice(7));
      else if (line.startsWith('author ')) {
        const parts = line.slice(7).split(' ');
        timestamp = parseInt(parts[parts.length - 2], 10);
        author = parts.slice(0, parts.length - 2).join(' ');
      } else if (line.startsWith('committer ')) {
        const parts = line.slice(10).split(' ');
        committer = parts.slice(0, parts.length - 2).join(' ');
      } else if (line === '') {
        messageStart = i + 1;
        break;
      }
    }
    const message = lines.slice(messageStart).join('\n');
    return new Commit(treeHash, parentHashes, author, committer, message, timestamp);
  }
}

class Repository {
  constructor(repoPath = '.') {
    this.path = path.resolve(repoPath);
    this.gitDir = path.join(this.path, '.git');
    this.objectsDir = path.join(this.gitDir, 'objects');
    this.refDir = path.join(this.gitDir, 'refs');
    this.headsDir = path.join(this.refDir, 'heads');
    this.headFile = path.join(this.gitDir, 'HEAD');
    this.indexFile = path.join(this.gitDir, 'index');
  }

  init() {
    if (fs.existsSync(this.gitDir)) return false;
    ensureDirSync(this.gitDir);
    ensureDirSync(this.objectsDir);
    ensureDirSync(this.refDir);
    ensureDirSync(this.headsDir);
    fs.writeFileSync(this.headFile, 'ref: refs/heads/master\n');
    this.saveIndex({});
    console.log(`Initialized empty Git repository in ${this.gitDir}`);
    return true;
  }

  storeObject(obj) {
    const objHash = obj.hash();
    const dir = path.join(this.objectsDir, objHash.slice(0, 2));
    const file = path.join(dir, objHash.slice(2));
    if (!fs.existsSync(file)) {
      ensureDirSync(dir);
      fs.writeFileSync(file, obj.serialize());
    }
    return objHash;
  }

  loadIndex() {
    if (!fs.existsSync(this.indexFile)) return {};
    try {
      const data = fs.readFileSync(this.indexFile, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return {};
    }
  }

  saveIndex(idx) {
    fs.writeFileSync(this.indexFile, JSON.stringify(idx, null, 2));
  }

  addFile(relPath) {
    const full = path.join(this.path, relPath);
    if (!fs.existsSync(full)) throw new Error(`Path ${relPath} not found`);
    const content = fs.readFileSync(full);
    const blob = new Blob(content);
    const blobHash = this.storeObject(blob);
    const index = this.loadIndex();
    index[relPath] = blobHash;
    this.saveIndex(index);
    console.log(`Added ${relPath}`);
  }

  addDirectory(relDir) {
    const fullDir = path.join(this.path, relDir);
    if (!fs.existsSync(fullDir)) throw new Error(`Directory ${relDir} not found`);
    if (!fs.statSync(fullDir).isDirectory()) throw new Error(`${relDir} is not a directory`);
    const index = this.loadIndex();
    let added = 0;
    const walk = (d) => {
      const items = fs.readdirSync(d);
      for (const item of items) {
        const fullPath = path.join(d, item);
        const rel = path.relative(this.path, fullPath).split(path.sep).join('/');
        if (rel.split('/').includes('.git')) continue;
        const st = fs.statSync(fullPath);
        if (st.isFile()) {
          const content = fs.readFileSync(fullPath);
          const blob = new Blob(content);
          const blobHash = this.storeObject(blob);
          index[rel] = blobHash;
          added++;
        } else if (st.isDirectory()) {
          walk(fullPath);
        }
      }
    };
    walk(fullDir);
    this.saveIndex(index);
    if (added > 0) console.log(`Added ${added} files from directory ${relDir}`);
    else console.log(`Directory ${relDir} already up to date`);
  }

  addPath(p) {
    const full = path.join(this.path, p);
    if (!fs.existsSync(full)) throw new Error(`Path ${p} not found`);
    if (fs.statSync(full).isFile()) this.addFile(p);
    else if (fs.statSync(full).isDirectory()) this.addDirectory(p);
    else throw new Error(`${p} is neither a file nor a directory`);
  }

  loadObject(objHash) {
    const dir = path.join(this.objectsDir, objHash.slice(0, 2));
    const file = path.join(dir, objHash.slice(2));
    if (!fs.existsSync(file)) throw new Error(`Object ${objHash} not found`);
    const data = fs.readFileSync(file);
    return GitObject.deserialize(data);
  }

  createTreeFromIndex() {
    const index = this.loadIndex();
    if (!index || Object.keys(index).length === 0) {
      const tree = new Tree();
      return this.storeObject(tree);
    }
    const dirs = {};
    const files = {};
    for (const [filePath, blobHash] of Object.entries(index)) {
      const parts = filePath.split('/');
      if (parts.length === 1) files[parts[0]] = blobHash;
      else {
        let dirName = parts[0];
        if (!dirs[dirName]) dirs[dirName] = {};
        let current = dirs[dirName];
        for (const part of parts.slice(1, -1)) {
          if (!current[part]) current[part] = {};
          current = current[part];
        }
        current[parts[parts.length - 1]] = blobHash;
      }
    }

    const createTreeRecursive = (entriesDict) => {
      const tree = new Tree();
      for (const [name, v] of Object.entries(entriesDict)) {
        if (typeof v === 'string') {
          tree.addEntry('100644', name, v);
        } else if (typeof v === 'object') {
          const subtreeHash = createTreeRecursive(v);
          tree.addEntry('40000', name, subtreeHash);
        }
      }
      return this.storeObject(tree);
    };

    const rootEntries = { ...files };
    for (const [dname, dcontents] of Object.entries(dirs)) rootEntries[dname] = dcontents;
    return createTreeRecursive(rootEntries);
  }

  getCurrentBranch() {
    if (!fs.existsSync(this.headFile)) return 'master';
    const content = fs.readFileSync(this.headFile, 'utf8').trim();
    if (content.startsWith('ref: refs/heads/')) return content.slice('ref: refs/heads/'.length);
    return 'HEAD';
  }

  getBranchCommit(branch) {
    const file = path.join(this.headsDir, branch);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    return null;
  }

  setBranchCommit(branch, commitHash) {
    const file = path.join(this.headsDir, branch);
    ensureDirSync(path.dirname(file));
    fs.writeFileSync(file, commitHash + '\n');
  }

  commit(message, author = 'PyGit User <user@pygit.com>') {
    const treeHash = this.createTreeFromIndex();
    const currentBranch = this.getCurrentBranch();
    const parentCommit = this.getBranchCommit(currentBranch);
    const parentHashes = parentCommit ? [parentCommit] : [];
    const index = this.loadIndex();
    if (!index || Object.keys(index).length === 0) {
      console.log('nothing to commit, working tree clean');
      return null;
    }

    if (parentCommit) {
      try {
        const parentGitObj = this.loadObject(parentCommit);
        const parentCommitData = Commit.fromContent(parentGitObj.content);
        if (treeHash === parentCommitData.treeHash) {
          console.log('nothing to commit, working tree clean');
          return null;
        }
      } catch (e) {
        // ignore
      }
    }

    const commitObj = new Commit(treeHash, parentHashes, author, author, message);
    const commitHash = this.storeObject(commitObj);
    this.setBranchCommit(currentBranch, commitHash);
    this.saveIndex({});
    console.log(`Created commit ${commitHash} on branch ${currentBranch}`);
    return commitHash;
  }

  getFilesFromTreeRecursive(treeHash, prefix = '') {
    const files = new Set();
    try {
      const treeObj = this.loadObject(treeHash);
      const tree = Tree.fromContent(treeObj.content);
      for (const e of tree.entries) {
        const [mode, name, objHash] = [e.mode, e.name, e.hashHex];
        const fullName = `${prefix}${name}`;
        if (mode.startsWith('100')) {
          files.add(fullName);
        } else if (mode.startsWith('400')) {
          const subtreeFiles = this.getFilesFromTreeRecursive(objHash, `${fullName}/`);
          for (const f of subtreeFiles) files.add(f);
        }
      }
    } catch (e) {
      console.warn(`Warning: Could not read tree ${treeHash}: ${e}`);
    }
    return files;
  }

  checkout(branch, createBranch = false) {
    const previousBranch = this.getCurrentBranch();
    let filesToClear = new Set();
    let previousCommitHash = null;
    try {
      previousCommitHash = this.getBranchCommit(previousBranch);
      if (previousCommitHash) {
        const prevCommitObj = this.loadObject(previousCommitHash);
        const prevCommit = Commit.fromContent(prevCommitObj.content);
        if (prevCommit.treeHash) filesToClear = this.getFilesFromTreeRecursive(prevCommit.treeHash);
      }
    } catch (e) {
      filesToClear = new Set();
    }

    const branchFile = path.join(this.headsDir, branch);
    if (!fs.existsSync(branchFile)) {
      if (createBranch) {
        if (previousCommitHash) {
          this.setBranchCommit(branch, previousCommitHash);
          console.log(`Created new branch ${branch}`);
        } else {
          console.log('No commits yet, cannot create a branch');
          return;
        }
      } else {
        console.log(`Branch '${branch}' not found.`);
        console.log(`Use 'node pygit.js checkout -b {branch}' to create and switch to a new branch.`);
        return;
      }
    }

    fs.writeFileSync(this.headFile, `ref: refs/heads/${branch}\n`);
    this.restoreWorkingDirectory(branch, filesToClear);
    console.log(`Switched to branch ${branch}`);
  }

  restoreTree(treeHash, dirPath) {
    const treeObj = this.loadObject(treeHash);
    const tree = Tree.fromContent(treeObj.content);
    for (const { mode, name, hashHex } of tree.entries) {
      const filePath = path.join(dirPath, name);
      if (mode.startsWith('100')) {
        const blobObj = this.loadObject(hashHex);
        // blobObj is a GitObject with type and content
        fs.writeFileSync(filePath, blobObj.content);
      } else if (mode.startsWith('400')) {
        ensureDirSync(filePath);
        this.restoreTree(hashHex, filePath);
      }
    }
  }

  restoreWorkingDirectory(branch, filesToClear) {
    const targetCommitHash = this.getBranchCommit(branch);
    if (!targetCommitHash) return;
    // remove files tracked by previous branch
    for (const relPath of [...filesToClear].sort()) {
      const filePath = path.join(this.path, relPath);
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
      } catch (e) {
        // ignore
      }
    }

    const targetCommitObj = this.loadObject(targetCommitHash);
    const targetCommit = Commit.fromContent(targetCommitObj.content);
    if (targetCommit.treeHash) this.restoreTree(targetCommit.treeHash, this.path);
    this.saveIndex({});
  }

  branch(branchName = null, del = false) {
    if (del && branchName) {
      const bfile = path.join(this.headsDir, branchName);
      if (fs.existsSync(bfile)) {
        fs.unlinkSync(bfile);
        console.log(`Deleted branch ${branchName}`);
      } else {
        console.log(`Branch ${branchName} not found`);
      }
      return;
    }
    const currentBranch = this.getCurrentBranch();
    if (branchName) {
      const currentCommit = this.getBranchCommit(currentBranch);
      if (currentCommit) {
        this.setBranchCommit(branchName, currentCommit);
        console.log(`Created branch ${branchName}`);
      } else {
        console.log('No commits yet, cannot create a new branch');
      }
    } else {
      const branches = [];
      if (fs.existsSync(this.headsDir)) {
        for (const f of fs.readdirSync(this.headsDir)) {
          if (f.startsWith('.')) continue;
          branches.push(f);
        }
      }
      for (const br of branches.sort()) {
        const marker = br === currentBranch ? '* ' : '  ';
        console.log(`${marker}${br}`);
      }
    }
  }

  log(maxCount = 10) {
    const currentBranch = this.getCurrentBranch();
    let commitHash = this.getBranchCommit(currentBranch);
    if (!commitHash) {
      console.log('No commits yet!');
      return;
    }
    let count = 0;
    while (commitHash && count < maxCount) {
      const commitObj = this.loadObject(commitHash);
      const commit = Commit.fromContent(commitObj.content);
      console.log(`commit ${commitHash}`);
      console.log(`Author: ${commit.author}`);
      console.log(`Date: ${new Date(commit.timestamp * 1000).toString()}`);
      console.log(`\n    ${commit.message}\n`);
      commitHash = commit.parentHashes.length > 0 ? commit.parentHashes[0] : null;
      count++;
    }
  }

  buildIndexFromTree(treeHash, prefix = '') {
    const index = {};
    try {
      const treeObj = this.loadObject(treeHash);
      const tree = Tree.fromContent(treeObj.content);
      for (const { mode, name, hashHex } of tree.entries) {
        const fullName = `${prefix}${name}`;
        if (mode.startsWith('100')) index[fullName] = hashHex;
        else if (mode.startsWith('400')) {
          const sub = this.buildIndexFromTree(hashHex, `${fullName}/`);
          Object.assign(index, sub);
        }
      }
    } catch (e) {
      console.warn(`Warning: Could not read tree ${treeHash}: ${e}`);
    }
    return index;
  }

  getAllFiles() {
    const files = [];
    const walk = (p) => {
      for (const item of fs.readdirSync(p)) {
        const full = path.join(p, item);
        const rel = path.relative(this.path, full).split(path.sep).join('/');
        if (rel.split('/').includes('.git')) continue;
        const st = fs.statSync(full);
        if (st.isFile()) files.push(full);
        else if (st.isDirectory()) walk(full);
      }
    };
    walk(this.path);
    return files;
  }

  status() {
    const currentBranch = this.getCurrentBranch();
    console.log(`On branch ${currentBranch}`);
    const index = this.loadIndex();
    const currentCommitHash = this.getBranchCommit(currentBranch);
    let lastIndexFiles = {};
    if (currentCommitHash) {
      try {
        const commitObj = this.loadObject(currentCommitHash);
        const commit = Commit.fromContent(commitObj.content);
        if (commit.treeHash) lastIndexFiles = this.buildIndexFromTree(commit.treeHash);
      } catch (e) {
        lastIndexFiles = {};
      }
    }

    const workingFiles = {};
    for (const f of this.getAllFiles()) {
      const rel = path.relative(this.path, f).split(path.sep).join('/');
      try {
        const content = fs.readFileSync(f);
        const blob = new Blob(content);
        workingFiles[rel] = blob.hash();
      } catch (e) {
        continue;
      }
    }

    const staged = [];
    const unstaged = [];
    const untracked = [];
    const deleted = [];

    for (const filePath of new Set([...Object.keys(index), ...Object.keys(lastIndexFiles)])) {
      const indexHash = index[filePath];
      const lastHash = lastIndexFiles[filePath];
      if (indexHash && !lastHash) staged.push(['new file', filePath]);
      else if (indexHash && lastHash && indexHash !== lastHash) staged.push(['modified', filePath]);
    }
    if (staged.length > 0) {
      console.log('\nChanges to be committed:');
      for (const [s, fp] of staged.sort()) console.log(`   ${s}: ${fp}`);
    }

    for (const fp of Object.keys(workingFiles)) {
      if (index[fp] && workingFiles[fp] !== index[fp]) unstaged.push(fp);
    }
    if (unstaged.length > 0) {
      console.log('\nChanges not staged for commit:');
      for (const fp of unstaged.sort()) console.log(`   modified: ${fp}`);
    }

    for (const fp of Object.keys(workingFiles)) {
      if (!index[fp] && !lastIndexFiles[fp]) untracked.push(fp);
    }
    if (untracked.length > 0) {
      console.log('\nUntracked files:');
      for (const fp of untracked.sort()) console.log(`   ${fp}`);
    }

    for (const fp of Object.keys(index)) {
      if (!workingFiles[fp]) deleted.push(fp);
    }
    if (deleted.length > 0) {
      console.log('\nDeleted files:');
      for (const fp of deleted.sort()) console.log(`   deleted: ${fp}`);
    }

    if (!staged.length && !unstaged.length && !deleted.length && !untracked.length) console.log('\nnothing to commit, working tree clean');
  }
}

// ----------------- CLI -----------------

function printHelp() {
  console.log('Usage: node pygit.js <command> [options]');
  console.log('Commands: init, add, commit, checkout, branch, log, status');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) return printHelp();
  const cmd = argv[0];
  const repo = new Repository('.');
  try {
    if (cmd === 'init') {
      if (!repo.init()) console.log('Repository already exists');
    } else if (cmd === 'add') {
      if (!fs.existsSync(repo.gitDir)) return console.log('Not a git repository');
      const paths = argv.slice(1);
      if (paths.length === 0) return console.log('No paths provided');
      for (const p of paths) repo.addPath(p);
    } else if (cmd === 'commit') {
      if (!fs.existsSync(repo.gitDir)) return console.log('Not a git repository');
      // simple parsing: -m "message" --author "...")
      let message = null;
      let author = null;
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '-m' || argv[i] === '--message') {
          message = argv[i + 1];
          i++;
        } else if (argv[i] === '--author') {
          author = argv[i + 1];
          i++;
        }
      }
      if (!message) return console.log('Commit message required: use -m "msg"');
      author = author || 'PyGit user <user@pygit.com>';
      repo.commit(message, author);
    } else if (cmd === 'checkout') {
      if (!fs.existsSync(repo.gitDir)) return console.log('Not a git repository');
      // options: -b
      let create = false;
      let branch = null;
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '-b' || argv[i] === '--create-branch') create = true;
        else branch = argv[i];
      }
      if (!branch) return console.log('Branch required');
      repo.checkout(branch, create);
    } else if (cmd === 'branch') {
      if (!fs.existsSync(repo.gitDir)) return console.log('Not a git repository');
      // usage: branch [name] [-d]
      let name = null;
      let del = false;
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '-d' || argv[i] === '--delete') del = true;
        else name = argv[i];
      }
      repo.branch(name, del);
    } else if (cmd === 'log') {
      if (!fs.existsSync(repo.gitDir)) return console.log('Not a git repository');
      let max = 10;
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '-n' || argv[i] === '--max-count') max = parseInt(argv[i + 1], 10), i++;
      }
      repo.log(max);
    } else if (cmd === 'status') {
      if (!fs.existsSync(repo.gitDir)) return console.log('Not a git repository');
      repo.status();
    } else {
      printHelp();
    }
  } catch (e) {
    console.error('Error:', e.message || e);
    process.exit(1);
  }
}

main();
