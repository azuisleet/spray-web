/**
 * Copies the production build into the GitHub Pages repository, replacing the previous
 * build there. It stops short of committing or pushing: review the result, then commit
 * and push in that repository to publish.
 *
 *   npm run deploy                 build, then replace the site's files
 *   npm run deploy -- --dry-run    build, then only list what would change
 *
 * The Pages repository is ../azuisleet.github.io next to this one, or DEPLOY_DIR.
 */
import {execFileSync} from "child_process";
import fs from "fs";
import path from "path";

const repo = path.resolve(import.meta.dirname, "..");
const dist = path.join(repo, "dist");
const target = path.resolve(process.env.DEPLOY_DIR ?? path.join(repo, "..", "azuisleet.github.io"));
const dryRun = process.argv.includes("--dry-run");

// Never removed from the Pages repository: its history, and files GitHub Pages reads.
const keep = new Set([".git", "CNAME", ".nojekyll"]);

function fail(message) {
    console.error(`deploy: ${message}`);
    process.exit(1);
}

function listFiles(root, base = root) {
    return fs.readdirSync(root, {withFileTypes: true}).flatMap(entry => {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) return listFiles(full, base);
        return [path.relative(base, full).split(path.sep).join("/")];
    });
}

if (!fs.existsSync(path.join(dist, "index.html"))) fail(`no build in ${dist}; run "npm run build" first`);
if (!fs.existsSync(path.join(target, ".git"))) fail(`${target} is not a git repository`);

// Guard against pointing this at the wrong folder: the target must be the Pages repository.
const remote = execFileSync("git", ["-C", target, "remote", "get-url", "origin"], {encoding: "utf8"}).trim();
if (!/azuisleet\.github\.io(\.git)?$/.test(remote)) fail(`${target} has remote ${remote}, not the azuisleet.github.io repository`);

const before = fs.readdirSync(target).filter(name => !keep.has(name))
    .flatMap(name => fs.statSync(path.join(target, name)).isDirectory() ? listFiles(path.join(target, name), target) : [name]);
const after = listFiles(dist);
const removed = before.filter(file => !after.includes(file));
const added = after.filter(file => !before.includes(file));

console.log(`${dryRun ? "Would replace" : "Replacing"} the site in ${target}`);
for (const file of removed) console.log(`  - ${file}`);
for (const file of added) console.log(`  + ${file}`);
console.log(`  ${after.length - added.length} file(s) overwritten in place`);

if (dryRun) process.exit(0);

for (const name of fs.readdirSync(target)) {
    if (!keep.has(name)) fs.rmSync(path.join(target, name), {recursive: true, force: true});
}
fs.cpSync(dist, target, {recursive: true});
// Serve the files as they are; Jekyll would skip anything starting with an underscore.
fs.writeFileSync(path.join(target, ".nojekyll"), "");

console.log(`\nDone. To publish, review and push the Pages repository:`);
console.log(`  git -C "${target}" status`);
console.log(`  git -C "${target}" add -A && git -C "${target}" commit -m "Update" && git -C "${target}" push`);
