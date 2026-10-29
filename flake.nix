{
  description = "Effect daemons: the daemon spec and conformance suite, and the process, socket and cluster media.";

  inputs = {
    # Core at a full commit. Core is public, so no fetch token is needed. Moving this pin is how the
    # repository takes newer core packages: bump it, rebuild .#sfs-deps, update the overrides and the lockfile.
    core.url = "github:systemfsoftware/systemfsoftware/31963d5a6452b488b73f8d559c85e7104dd3b443";
    nixpkgs.follows = "core/nixpkgs";
    pnpm-release-management.follows = "core/pnpm-release-management";
  };

  outputs = { self, nixpkgs, core, pnpm-release-management }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = fn: lib.genAttrs systems (system: fn nixpkgs.legacyPackages.${system});

      # Every tarball pnpm-lock.yaml names under `file:.sfs-deps/`, by producer.
      sfsPackages = {
        core = [ "conformance-spec" "effect-cell-types" "effect-gherkin-spec" "effect-readiness" "effect-schema-discovery" "effect-schema-law" "effect-schema-recursion-budget" "effect-schema-vite" "effect-sim-kernel" "effect-spec-runtime" "oxlint-config-cell-architecture" "oxlint-config-dmmf" "oxlint-config-recommended" "oxlint-config-rule-authoring" "oxlint-plugin-cell-architecture" "oxlint-plugin-dmmf-workflow" "oxlint-plugin-effect-platform" "oxlint-plugin-effect-schema" "oxlint-plugin-test-discipline" "stryker-config" "tsconfig" "tsdown-config" "vitest" "vitest-config" ];
      };

      producers = system: {
        core = core.packages.${system};
      };

      # Each tarball is its producer's own per-package output, so a cold build makes only these.
      sfsDepsOf = pkgs:
        let
          system = pkgs.stdenv.hostPlatform.system;
          pick = producer: name:
            let
              upstream = (producers system).${producer};
              member = lib.findFirst (member: member.attr == name)
                (throw "flake.nix: ${producer} has no public workspace package named ${name}")
                upstream.workspace-tarballs.members;
            in
            { name = member.tarball; path = upstream.${member.attr}; };
        in
        pkgs.linkFarm "sfs-deps"
          (lib.concatLists (lib.mapAttrsToList (producer: names: map (pick producer) names) sfsPackages));

      # This repository's own public packages, as tarballs downstream flakes consume the same way.
      workspaceOf = pkgs:
        pnpm-release-management.lib.mkPnpmWorkspacePackages {
          inherit pkgs;
          src = self;
          pname = "effect-daemon";
          pnpm = pkgs.pnpm_12;
          files.".sfs-deps" = sfsDepsOf pkgs;
        };
    in
    {
      packages = forEachSystem (pkgs:
        let system = pkgs.stdenv.hostPlatform.system; in
        workspaceOf pkgs // {
          sfs-deps = sfsDepsOf pkgs;
          inherit (core.packages.${system}) dprint;
        });

      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = [
            core.packages.${pkgs.stdenv.hostPlatform.system}.dprint
            pkgs.nodejs_24
            pkgs.pnpm_12
          ];
        };
      });
    };
}
