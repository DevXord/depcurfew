// Ecosystems whose package manager has no release-age delay that depcurfew configures: Cargo, Go modules, Maven,
// Gradle and NuGet (decision D-151). depcurfew finds them by their files and delays their new versions only through the
// update bots (dependabot.ts: botOnlyEcosystems, renovate.ts: botOnlyEcosystems). Read from the official sources in
// their GitHub repositories (doc.rust-lang.org, go.dev, maven.apache.org and learn.microsoft.com were not reachable
// from this session; their pages are built from these files).
import { verifiedOn } from './define.ts';
import type { BotOnlyEcosystemId, BotOnlyEcosystemKnowledge } from './types.ts';

const { verified, uncertain } = verifiedOn('2026-11-03');

const CARGO = 'https://github.com/rust-lang/cargo/blob';
const GRADLE_DOCS = 'https://github.com/gradle/gradle/blob/v9.8.2/platforms/documentation/docs/src/docs';
const NUGET_DOCS = 'https://github.com/NuGet/docs.microsoft.com-nuget/blob/main/docs';

export const botOnlyEcosystems: Readonly<Record<BotOnlyEcosystemId, BotOnlyEcosystemKnowledge>> = {
  cargo: {
    project: verified(
      { name: 'Cargo', client: 'Cargo', files: ['Cargo.toml', 'Cargo.lock'] },
      `${CARGO}/rust-1.99.0/doc/book/src/guide/cargo-toml-vs-cargo-lock.md`,
      '"Cargo.toml is about describing your dependencies in a broad sense" (the manifest) and "Cargo.lock contains exact information about your dependencies" (the Cargo book of Cargo 1.99, guide/cargo-toml-vs-cargo-lock.md).',
    ),
    releaseAge: uncertain(
      { setting: 'registry.global-min-publish-age', since: '1.100.0', product: 'Cargo', file: '.cargo/config.toml' },
      `${CARGO}/master/doc/book/src/CHANGELOG.md`,
      'The changelog of the Cargo book on master lists under "Cargo 1.100 (2026-11-12)": "Stabilize minimum publish age configurations. When registry.global-min-publish-age is set, the resolver ignores versions published more recently than that, unless they are already in Cargo.lock" (RFC 3923, rust-lang/cargo#17335); reference/config.md on master documents registry.global-min-publish-age (default "0", values such as "14 days"), registries.<name>.min-publish-age and resolver.incompatible-publish-age, read from .cargo/config.toml. On 2026-11-03 Cargo 1.100 is not released: the latest Rust release is 1.99.1 of 2026-10-15 (RELEASES.md on the stable branch of rust-lang/rust), and Cargo 1.99 has the setting only behind the nightly flag -Zmin-publish-age (doc/book/src/reference/unstable.md at rust-1.99.0, which lists no stable setting in config.md). Uncertain because 1.100 is a planned release; until a repository runs Cargo 1.100, Cargo has no release-age delay of its own.',
    ),
  },
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
    releaseAge: uncertain(
      { setting: 'minPublishAgeHours', since: '11.0.100', product: '.NET SDK', updatesOnly: true, file: 'nuget.config' },
      'https://github.com/NuGet/Home/blob/dev/accepted/2026/package-update-cooldown.md',
      'The accepted design "Package update cooldown V1" adds a minPublishAgeHours attribute to the package sources of nuget.config (whole hours; none means 0) and a <minPublishAgeExceptions> section; Visual Studio, dotnet package update and dotnet package list --outdated pick or report only versions published at least that long ago, while restore does no cooldown checks (it only fails for floating versions when cooldown is on). NuGet.Client merged it into dev in August and September 2026 (pull requests 7622 and 7713), and MinPublishAgeExceptions.cs is in the v11.0.100-rc.3.26522.148 tag of dotnet/dotnet but not in v10.0.403, the latest released SDK on 2026-11-03; the .NET 11 release on 2026-10-25 is 11.0.0-rc.3 (release-notes/11.0/releases.json in dotnet/core), and the nuget.config reference on learn.microsoft.com (reference/nuget-config-file.md) does not list minPublishAgeHours. Uncertain because .NET SDK 11.0.100 is not released.',
    ),
  },
};
