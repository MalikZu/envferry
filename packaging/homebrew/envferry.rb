require "language/node"

# Homebrew formula for envferry. The url and sha256 below are placeholders that
# the release workflow (.github/workflows/release.yml) fills from the published
# npm tarball before committing the rendered formula to the homebrew-envferry tap.
class Envferry < Formula
  desc "Move .env files between machines without pasting secrets into chat"
  homepage "https://github.com/MalikZu/envferry"
  url "__URL__"
  sha256 "__SHA__"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "envferry", shell_output("#{bin}/envferry --help")
  end
end
