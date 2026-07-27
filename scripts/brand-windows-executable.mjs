import path from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import * as PELibrary from "pe-library";
import * as ResEdit from "resedit";

const executablePath = path.resolve(
  process.argv[2] ?? "release/win-unpacked/PocketDock.exe"
);
const temporaryPath = `${executablePath}.branded`;
const executable = PELibrary.NtExecutable.from(await readFile(executablePath), {
  ignoreCert: true
});
const resources = PELibrary.NtExecutableResource.from(executable);
const iconFile = ResEdit.Data.IconFile.from(await readFile("build/icon.ico"));
const iconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
const group = iconGroups[0] ?? { id: 1, lang: 1033 };

ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  resources.entries,
  group.id,
  group.lang,
  iconFile.icons.map((item) => item.data)
);

const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
if (!versions.length) throw new Error("PocketDock.exe has no Windows version resource.");
for (const version of versions) {
  version.setFileVersion(4, 0, 1, 10, 1033);
  version.setProductVersion(4, 0, 1, 10, 1033);
  version.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      CompanyName: "DocDamage",
      FileDescription: "PocketDock private iPhone file bridge",
      InternalName: "PocketDock.exe",
      LegalCopyright: "Copyright © 2026 DocDamage",
      OriginalFilename: "PocketDock.exe",
      ProductName: "PocketDock",
      ProductVersion: "4.0.1"
    }
  );
  version.outputToResourceEntries(resources.entries);
}

resources.outputResource(executable);
await writeFile(temporaryPath, Buffer.from(executable.generate()));
await rename(temporaryPath, executablePath);
process.stdout.write(`Branded Windows executable: ${executablePath}\n`);
