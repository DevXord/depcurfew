// Ecosystems whose package manager has no release-age delay that depcurfew configures: Go modules, Maven, Gradle and
// NuGet (decision D-151; Cargo left them in 1.7.0, when depcurfew apply began to write its delay, E08). depcurfew finds
// them by their files and delays their new versions only through the update bots (dependabot.ts: botOnlyEcosystems,
// renovate.ts: botOnlyEcosystems). Read from the official sources in their GitHub repositories (go.dev,
// maven.apache.org and learn.microsoft.com were not reachable from this session; their pages are built from these
// files).
import { verifiedOn } from './define.ts';
import type { BotOnlyEcosystemId, BotOnlyEcosystemKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-11-03');
const dotnet11 = verifiedOn('2026-11-11');
// The .NET SDK's dnx, which the hook no longer reads as Deno's (decision D-208).
const d208 = verifiedOn('2026-11-11');

const GRADLE_DOCS = 'https://github.com/gradle/gradle/blob/v9.8.2/platforms/documentation/docs/src/docs';
const NUGET_DOCS = 'https://github.com/NuGet/docs.microsoft.com-nuget/blob/main/docs';
const NUGET_DOCS_D205 = 'https://github.com/NuGet/docs.microsoft.com-nuget/blob/2f8406a736ab57c51caffa4701fc21fb7f141c1b/docs';

export const botOnlyEcosystems: Readonly<Record<BotOnlyEcosystemId, BotOnlyEcosystemKnowledge>> = {
  gomod: {
    project: verified(
      { name: 'Go modules', client: 'Go', files: ['go.mod', 'go.sum'] },
      'https://github.com/golang/website/blob/master/_content/ref/mod.md',
      'The Go Modules Reference (go.dev/ref/mod): "A module is defined by a UTF-8 encoded text file named go.mod in its root directory" and "A module may have a text file named go.sum in its root directory, alongside its go.mod file" with the hashes of its dependencies (read on 2026-11-03).',
    ),
    releaseAge: uncertain(
      { setting: null, since: null },
      'https://github.com/golang/go/blob/go1.27.3/src/cmd/go/alldocs.go',
      'Concluded from the absence of a setting: the documentation of the go command at go1.27.3, the latest tag on 2026-11-03, and the Go Modules Reference name no environment variable, go.mod directive or flag that holds back recently published module versions. The proposal for one, "cmd/go: support dependency cooldown in Go tooling" (https://github.com/golang/go/issues/76485), is open and was placed on hold by the proposal review group on 2026-06-25, which first explores a cooldown in the module proxy.',
    ),
  },
  maven: {
    project: verified(
      { name: 'Maven', client: 'Maven', files: ['pom.xml'] },
      'https://github.com/apache/maven-site/blob/master/content/markdown/guides/introduction/introduction-to-the-pom.md',
      'Introduction to the POM: "A Project Object Model or POM is the fundamental unit of work in Maven. It is an XML file that contains information about the project", with the project dependencies; "When executing a task or goal, Maven looks for the POM in the current directory", and the examples name it pom.xml, also in modules (my-module/pom.xml).',
    ),
    releaseAge: uncertain(
      { setting: null, since: null },
      'https://github.com/apache/maven/blob/maven-4.0.0-rc-5/api/maven-api-core/src/main/java/org/apache/maven/api/Constants.java',
      'Concluded from the absence of a setting: Constants.java of Maven 4.0.0-rc-5 lists the maven.* properties Maven reads, and ConfigurationProperties.java of Maven Resolver 2.0.19 (https://github.com/apache/maven-resolver/blob/maven-resolver-2.0.19/maven-resolver-api/src/main/java/org/eclipse/aether/ConfigurationProperties.java) the aether.* properties of dependency resolution; none of them holds back recently published versions (no cooldown, publish date or minimum age).',
    ),
  },
  gradle: {
    project: verified(
      { name: 'Gradle', client: 'Gradle', files: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle/libs.versions.toml'] },
      `${GRADLE_DOCS}/userguide/fundamentals/authoring-builds/gradle_directories_intermediate.adoc`,
      'The Gradle 9.8.2 user guide shows a project with settings.gradle(.kts) in the root directory ("lets Gradle know about the structure of the build") and build.gradle(.kts) in each project, "declaring dependencies and applying plugins"; dependencies_intermediate.adoc in the same directory recommends a version catalog in gradle/libs.versions.toml for the dependency versions.',
    ),
    releaseAge: uncertain(
      { setting: null, since: null },
      'https://github.com/gradle/gradle/blob/v9.8.2/subprojects/core-api/src/main/java/org/gradle/api/artifacts/ResolutionStrategy.java',
      'Concluded from the absence of a setting: ResolutionStrategy of Gradle 9.8.2, the latest release on 2026-11-03 (released-versions.json on master), has no setting that holds back recently published versions, and neither the release notes of 9.8.2 nor those of 9.9.0-rc-1 on master (platforms/documentation/docs/src/docs/release/notes.md) mention one.',
    ),
  },
  nuget: {
    project: verified(
      { name: 'NuGet', client: 'NuGet', files: ['packages.config', 'Directory.Packages.props', 'nuget.config', 'NuGet.config', 'NuGet.Config'], extensions: ['.csproj', '.fsproj', '.vbproj'] },
      `${NUGET_DOCS}/consume-packages/Package-References-in-Project-Files.md`,
      'PackageReference items "specify NuGet package dependencies directly within project files, as opposed to having a separate packages.config file" (packages.config: reference/packages-config.md); Central Package Management keeps the versions in a Directory.Packages.props "at the root of your repository" (consume-packages/Central-Package-Management.md). Project files have extensions "like .csproj for C# projects and .fsproj for F# projects", and dependencies are referenced in "the project file (.csproj or .vbproj)" (docs/core/project-sdk/overview.md and docs/core/tools/dotnet-restore.md in dotnet/docs). NuGet reads nuget.config, NuGet.config and NuGet.Config, in this order (OrderedSettingsFileNames in src/nuget-client/src/NuGet.Core/NuGet.Configuration/Settings/Settings.cs at the v10.0.403 tag of dotnet/dotnet).',
    ),
    // Verified after the .NET 11 release (decision D-205).
    releaseAge: dotnet11.verified(
      { setting: 'minPublishAgeHours', since: '11.0.100', product: '.NET SDK', selectedBy: ['dotnet package add', 'dotnet package update'], ignoredBy: 'the 10.0 SDKs and earlier', file: 'nuget.config' },
      `${NUGET_DOCS_D205}/consume-packages/minimum-package-publish-age.md`,
      'Minimum package publish age "is available starting with NuGet 8.0, .NET SDK 11.0.100, and Visual Studio 18.12" and is set with the minPublishAgeHours attribute of a source in packageSources of nuget.config, in whole hours (reference/nuget-config-file.md: whole numbers from 0 through 256204778, default 0). It covers only the automatic version choice: "When dotnet package add and dotnet package update select the latest version for you, they exclude versions that haven\'t reached the source\'s minimum publish age"; "Explicitly requesting a version bypasses automatic age filtering"; "Ordinary package restore doesn\'t check minimum publish age", which "also applies to transitive dependencies"; and restore fails with NU1020 for a floating version, such as 1.2.*, when an applicable source has a nonzero age and the package is not excepted (reference/errors-and-warnings/nu1020.md). The page names no other command that filters versions. Still open in NuGet/Home are the issues for dotnet package list (https://github.com/NuGet/Home/issues/15029), dotnet package search (https://github.com/NuGet/Home/issues/15030), the Package Manager Console of Visual Studio (https://github.com/NuGet/Home/issues/15033) and its Package Manager UI (https://github.com/NuGet/Home/issues/15034); dotnet tool, dnx and dotnet new install are not documented as covered. The pages were read at commit 2f8406a736ab57c51caffa4701fc21fb7f141c1b of main; the live branch, from which learn.microsoft.com is published, has the same minimum-package-publish-age.md and nu1020.md at e62116dc63c026b36434e1d28d9557e4c0e91912 (2026-11-11; learn.microsoft.com itself was not checked). .NET 11.0.0 was released on 2026-11-10 with SDK 11.0.100 and Visual Studio 18.12.0 (release-notes/11.0/releases.json at https://github.com/dotnet/core/blob/ff6107d71eb826353b4e577cfd0c88fe703aa5b5/release-notes/11.0/releases.json). The v11.0.100 tag of dotnet/dotnet builds NuGet 8.0.0 (https://github.com/dotnet/dotnet/blob/v11.0.100/src/nuget-client/build/config.props) from nuget-client commit f1c3fba23859095e1b9261e935c8c7b1e1642a85 (src/source-manifest.json), whose ConfigurationContants.cs names minPublishAgeHours; the prerelease tag v11.0.100-rc.3.26522.148 already builds NuGet 8.0.0 from nuget-client commit 684427012e25096073d04a7643a9d43dc1f2091d, which names it too, so only the 10.0 SDKs and earlier are named as ignoring it (ignoredBy); at v10.0.404, the latest 10.0 SDK, NuGet is 7.9.0 and its configuration code has no such name, so it keeps the attribute without reading it (AddItem.cs stores unknown attributes).',
    ),
    toolRunner: d208.verified(
      { executables: ['dnx'], since: '10.0.100', product: '.NET SDK', runs: [['dotnet', 'dnx'], ['dotnet', 'tool', 'exec'], ['dotnet', 'tool', 'execute']], packageId: '^\\w+([.-]\\w+)*$' },
      'https://github.com/dotnet/sdk/blob/v10.0.100/src/Layout/redist/dnx',
      'The script dnx runs "$(dirname "$0")/dotnet" dnx "$@", and dnx.cmd runs "%~dp0dotnet.exe" dnx %*, the same at v11.0.100; in src/Layout/redist/targets/GenerateInstallerLayout.targets the LayoutDnxShim target copies the one for the platform into the layout, and PrepareIntermediateSdkInstallerOutput copies it into the root dotnet folder ("Copy dnx script to root dotnet folder (which will map to DOTNETHOME)"), at v10.0.100 and v11.0.100; v9.0.100 and v9.0.300 have no dnx. dotnet dnx is a hidden command with the arguments and options of dotnet tool execute, whose alias is exec, and runs it (src/Cli/dotnet/Commands/Dnx/DnxCommandParser.cs and Tool/Execute/ToolExecuteCommandParser.cs at v10.0.100). dotnet/docs docs/core/tools/dotnet-tool-exec.md at commit cbcb05470e3f7ff6e144ac3d2d696d304cf73120, lines 43-44: "dotnet dnx - A hidden alias for dotnet tool exec" and "dnx - A shell script that invokes dotnet dnx from the SDK. This script is provided by the installer and is available on PATH"; the tool is a NuGet package ID, optionally with @<version>. Package IDs match ^\\w+([.-]\\w+)*$ (IdRegex in src/nuget-client/src/NuGet.Core/NuGet.Packaging/PackageCreation/Utility/PackageIdValidator.cs, lines 17-18, at v11.0.100 of dotnet/dotnet, the same at v10.0.100), so no ID holds a colon. depcurfew does not look NuGet packages up, so the hook gives these commands no decision (decision D-208).',
    ),
  },
};
