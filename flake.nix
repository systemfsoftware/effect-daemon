{
  description = "Effect daemons: the daemon spec and conformance suite, and the process, socket and cluster media.";

  nixConfig = {
    extra-substituters = "https://nix.systemfsoftware.com";
    extra-trusted-public-keys = "nix-cache-1:wXA8I4DayNW9q6enUyQA/P/nT38pGSTLt374t3gsn7M=";
    fallback = true;
  };

  inputs = {
    # Core at a full commit. Core is public, so no fetch token is needed. Moving this pin is how the
    # repository takes newer core packages: bump it, then run `nix flake lock` and refresh the overrides.
    core.url = "github:systemfsoftware/systemfsoftware/15b4d2ab1e2af0a154fad2b9af7bd1f6449b3606";
    nixpkgs.follows = "core/nixpkgs";
    pnpm-release-management.url = "github:systemfsoftware/pnpm-release-management";
    # Second producer: core no longer ships effect-readiness, so it comes from its own repository, pinned at a full commit.
    effect-readiness.url = "github:systemfsoftware/effect-readiness/ae821eaf5484d1e8dac9e2fa4019d1563092d958";
  };

  outputs = { self, nixpkgs, core, pnpm-release-management, effect-readiness }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = fn: lib.genAttrs systems (system: fn nixpkgs.legacyPackages.${system});

      # Each producer's public packages, taken whole from its flake input: one version-free tarball per member.
      producerTarballsOf = pkgs:
        pnpm-release-management.lib.mkProducerTarballs {
          inherit pkgs;
          producers = { inherit core effect-readiness; };
        };

      # This repository's own public packages, as tarballs downstream flakes consume the same way.
      workspaceOf = pkgs:
        pnpm-release-management.lib.mkPnpmWorkspacePackages {
          inherit pkgs;
          src = self;
          pname = "effect-daemon";
          pnpm = pkgs.pnpm_12;
          files.".deps" = producerTarballsOf pkgs;
        };
    in
    {
      packages = forEachSystem (pkgs:
        let system = pkgs.stdenv.hostPlatform.system; in
        workspaceOf pkgs // {
          producer-tarballs = producerTarballsOf pkgs;
          inherit (core.packages.${system}) dprint;
        });

      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = [
            core.packages.${pkgs.stdenv.hostPlatform.system}.dprint
            pkgs.nodejs_24
            pkgs.pnpm_12
          ];
          shellHook = self.packages.${pkgs.stdenv.hostPlatform.system}.producer-tarballs.shellHook;
        };
      });
    };
}
