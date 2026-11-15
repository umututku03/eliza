#!/usr/bin/perl
# Shared engine for make-anon-artifact.sh and check-anon.sh. Works on a COPY of the artifact only.
#
#   perl anon.pl secrets  ROOT                      -> prints "rel:line:class" for secret-looking values
#   perl anon.pl scrub    ROOT REPLACEMENTS MANUAL  -> edits files under ROOT in place; writes reports
#   perl anon.pl check    ROOT [ALLOWFILE]          -> prints "rel:line:class" for residual identifying text
#   perl anon.pl manifest ROOT                      -> prints "sha256  ./rel" for every file
#
# Identity terms (user names, logins, ...) come from the ANON_TERMS environment variable, one per line.
# Values are never printed: every report line names a file, a line number and a pattern class only.
use strict;
use warnings;
use File::Find;
use Digest::SHA;

my ($mode, $root, @rest) = @ARGV;
die "usage: anon.pl secrets|scrub|check|manifest ROOT ...\n" unless $mode && defined $root && -d $root;
$root =~ s{/+$}{};

# ---------------------------------------------------------------- identity terms
my %seen;
my @terms = grep { length($_) >= 3 && !$seen{lc $_}++ }
            map { my $t = $_; $t =~ s/^\s+|\s+$//g; $t } split /\n/, ($ENV{ANON_TERMS} // '');
@terms = sort { length($b) <=> length($a) } @terms;
my $TERMS = @terms ? join('|', map { quotemeta } @terms) : undef;

# Public owners whose GitHub URLs do not identify the authors.
my $GH_ALLOW = qr/(?:elizaOS|elizaos|foundry-rs|Uniswap|OpenZeppelin|oven-sh|wevm|paradigmxyz|ethereum|nodejs|microsoft|vitest-dev|anthropics|openai)\b/;

# ---------------------------------------------------------------- scrub rules (order matters)
# [class, regex, replacement-sub]
my @rules = (
  ['attribution', qr/\b(?:Co-Authored-By|Signed-off-by|Reviewed-by|Reported-by|Acked-by)\s*:.*$/i,
                  sub { '[attribution removed]' }],
  ['copyright',   qr/\b(Copyright\s+(?=\(c\)|\(C\)|\xC2\xA9|\d{4})(?:(?:\([cC]\)|\xC2\xA9)\s*)?(?:\d{4}(?:\s*[-,]\s*\d{4})*,?\s*)?)(?!(?:elizaOS|Uniswap|OpenZeppelin|The Ethereum)\b)(\S.*)$/,
                  sub { "$1ANON_AUTHORS" }],
  ['repo-url',    qr{(?:https?://|ssh://git@|git@)?(?:www\.)?github\.com[:/](?!$GH_ALLOW)[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?(?:\.git)?},
                  sub { 'ANON_REPO_URL' }],
  ['email',       qr/(?<![\w.%+-])[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|org|net|edu|io|ca|dev|ai|co|uk|de|me|app|info|us|tr|ch)\b/,
                  sub { 'ANON_EMAIL' }],
  ['scratch-path', qr{(?:/private)?/tmp/claude-[^\s'"`)\]>,;]*}, sub { '$TMPDIR/ANON_SCRATCH' }],
  ['scratch-path', qr{(?:/private)?/var/folders/[^\s'"`)\]>,;]*}, sub { '$TMPDIR/ANON_TMP' }],
  ['home-path',   qr{/(?:Users|home)/(?!Shared\b)[A-Za-z0-9._-]+}, sub { '$HOME' }],
  ($TERMS ? (['owner-repo', qr{\b(?:$TERMS)/[A-Za-z0-9_.-]+}i, sub { 'ANON_REPO' }]) : ()),
  ['codename',    qr/\bspartan-agent\b/i, sub { 'ANON_REPO' }],
  ($TERMS ? (['identity', qr/(?<![A-Za-z0-9])(?:$TERMS)(?![A-Za-z0-9])/i, sub { 'ANON_AUTHOR' }]) : ()),
  ['codename',    qr/\bspartan\b/i, sub { 'ANON_AGENT' }],
);

# ---------------------------------------------------------------- secret patterns (never printed)
# Anvil/Hardhat well-known dev keys (accounts 0-9 of "test test ... junk"): public, allowed.
my %ANVIL = map { lc($_) => 1 } qw(
  ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
  7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
  47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
  8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
  92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
  4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356
  dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97
  2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6
);
my @secret_rules = (
  ['anthropic-key', qr/\bsk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}|\bsk-ant-[A-Za-z0-9_-]{40,}/],
  ['openai-key',    qr/\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ['github-token',  qr/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['aws-key',       qr/\bAKIA[0-9A-Z]{16}\b/],
  ['rpc-url-key',   qr{(?:alchemy(?:api)?\.(?:com|io)/v2/|infura\.io/v3/|quiknode\.pro/|ankr\.com/[a-z_]+/)[A-Za-z0-9_-]{16,}}i],
  ['pem-private-key', qr/-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['env-secret',    qr/^\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PRIVATE_KEY|RPC_URL|MNEMONIC)\s*=\s*['"]?(?![^\s'"]*(?:placeholder|example|your|xxx|<|\$\{?))[^\s'"\$<]{16,}/],
);
# Obvious synthetic fixtures (e.g. "ghp_abcdefghij...0123456789", "x" * 40) are reported as
# "<class>-fixture" for manual confirmation instead of failing the build.
my $FIXTURE = qr/0123456789|123456789|abcdefghij|ABCDEFGHIJ|(.)\1{7,}|placeholder|example|dummy|fake|redacted/i;
sub secret_classes {
  my ($line) = @_;
  my @hits;
  for my $r (@secret_rules) {
    while ($line =~ /($r->[1])/g) {
      push @hits, ($1 =~ $FIXTURE) ? "$r->[0]-fixture" : $r->[0];
    }
  }
  # 64-hex values on a line that talks about keys: private key unless a well-known Anvil key.
  if ($line =~ /priv|secret|mnemonic|signer|\bpk\b|_key\b|key\s*[:=]|key['"]?\s*:/i) {
    while ($line =~ /(?<![0-9a-fA-Fx])(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g) {
      unless ($ANVIL{lc $1}) { push @hits, 'hex-private-key'; last; }
    }
  }
  my %u; return grep { !$u{$_}++ } @hits;
}

# ---------------------------------------------------------------- manual-review heuristics
my $HASHLIKE = qr/(?<![0-9A-Za-z_x\/.\-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}(?![0-9A-Za-z_])/;
my $BRANCHLIKE = qr{\b(?:origin|upstream)/[A-Za-z0-9._/-]+|\bws/[A-Za-z0-9._-]+|\b(?:research|docs|feat|fix|codex)/[A-Za-z0-9._-]*-20\d{6}\b};
# Backticked "prefix/name" that is not a path in the artifact, e.g. `research/chain-faults`.
my $BRANCHTICK = qr{`((?:research|docs|feat|fix|codex|ws)/[A-Za-z0-9_-]+)`};
# Words that reveal the authors' situation (student project, course, lab) rather than their names.
my $SOFTID = qr/\b(?:supervisor|advisor|thesis|coursework|course project|CSC ?\d{3}|universit(?:y|ies)|professor)\b/i;

# ---------------------------------------------------------------- file walking / kinds
sub files {
  my @f;
  find({ no_chdir => 1, wanted => sub { push @f, $File::Find::name if -f $_ } }, $root);
  return sort @f;
}
sub rel { my $p = shift; $p =~ s{^\Q$root\E/}{}; return $p; }
sub kind {
  my ($path) = @_;
  my $b = $path; $b =~ s{.*/}{};
  return 'doc'   if $b =~ /\.(?:md|txt|tex|bib|rst)$/i;
  return 'slash' if $b =~ /\.(?:ts|tsx|js|jsx|mjs|cjs|sol)$/i;
  return 'hash'  if $b =~ /\.(?:py|sh|bash|toml|ya?ml)$/i || $b =~ /^\.(?:git|npm)ignore$/;
  return 'data'; # json, lock, patch, unknown: no comment syntax we trust
}
sub read_lines {
  my ($p) = @_;
  open(my $fh, '<:raw', $p) or die "read $p: $!\n";
  local $/; my $s = <$fh>; close $fh;
  return () unless defined $s && length $s;
  return split /(?<=\n)/, $s;
}

# Split a line into [text, is_comment] pieces. Strings are tracked per line; a multi-line string
# that contains comment markers may be misclassified (documented in ANON-CHECKLIST.md).
sub split_line {
  my ($line, $kind, $st) = @_;
  return ([$line, 1]) if $kind eq 'doc';
  return ([$line, 0]) if $kind eq 'data';
  if ($kind eq 'hash') {
    if ($st->{doc}) { $st->{doc} = 0 if $line =~ /"""|'''/; return ([$line, 1]); }
    if ($line =~ /^\s*[rRuUbB]?("""|''')/) {
      my $q = $1; my $cnt = () = $line =~ /\Q$q\E/g;
      $st->{doc} = ($cnt % 2) ? 1 : 0;
      return ([$line, 1]);
    }
  }
  my @p; my $buf = ''; my $c = $st->{block} ? 1 : 0; my $q = '';
  my $n = length $line; my $i = 0;
  while ($i < $n) {
    my $ch = substr($line, $i, 1); my $two = substr($line, $i, 2);
    if ($c) {
      if ($two eq '*/') { $buf .= '*/'; $i += 2; push @p, [$buf, 1]; $buf = ''; $c = 0; next; }
      $buf .= $ch; $i++; next;
    }
    if ($q) {
      $buf .= $ch;
      if ($ch eq '\\') { $buf .= substr($line, $i + 1, 1); $i += 2; next; }
      $q = '' if $ch eq $q; $i++; next;
    }
    if ($ch eq '"' || $ch eq "'" || ($kind eq 'slash' && $ch eq '`')) { $q = $ch; $buf .= $ch; $i++; next; }
    if ($kind eq 'slash' && $two eq '//') { push @p, [$buf, 0] if length $buf; $buf = substr($line, $i); $c = 2; last; }
    if ($kind eq 'slash' && $two eq '/*') { push @p, [$buf, 0] if length $buf; $buf = '/*'; $i += 2; $c = 1; next; }
    if ($kind eq 'hash' && $ch eq '#' && ($i == 0 || substr($line, $i - 1, 1) =~ /\s/)) {
      push @p, [$buf, 0] if length $buf; $buf = substr($line, $i); $c = 2; last;
    }
    $buf .= $ch; $i++;
  }
  push @p, [$buf, $c ? 1 : 0] if length $buf;
  $st->{block} = ($c == 1) ? 1 : 0;
  return @p;
}

# ---------------------------------------------------------------- modes
if ($mode eq 'manifest') {
  for my $f (files()) {
    my $r = rel($f); next if $r eq 'MANIFEST.sha256';
    my $d = Digest::SHA->new(256); $d->addfile($f, 'b');
    print $d->hexdigest, "  ./$r\n";
  }
  exit 0;
}

if ($mode eq 'secrets') {
  my $found = 0;
  for my $f (files()) {
    next if -B $f;
    my $r = rel($f); my $ln = 0;
    for my $line (read_lines($f)) {
      $ln++;
      for my $cls (secret_classes($line)) { print "$r:$ln:$cls\n"; $found++ unless $cls =~ /-fixture$/; }
    }
  }
  exit($found ? 1 : 0);
}

if ($mode eq 'scrub') {
  my ($repf, $manf) = @rest;
  open(my $REP, '>', $repf) or die "write $repf: $!\n";
  open(my $MAN, '>', $manf) or die "write $manf: $!\n";
  for my $f (files()) {
    if (-B $f) { print $MAN rel($f) . ":0:binary-file (not scanned; inspect by hand)\n"; next; }
    my $r = rel($f); my $k = kind($f); my %st; my $ln = 0; my $changed = 0; my @out;
    my (%hash_lines, %branch_lines, %soft_lines, %code_seen);
    for my $line (read_lines($f)) {
      $ln++;
      my @pieces = split_line($line, $k, \%st);
      for my $pc (@pieces) {
        if ($pc->[1]) {
          for my $rule (@rules) {
            my ($cls, $re, $sub) = @$rule;
            my $cnt = ($pc->[0] =~ s/$re/$sub->()/ge);
            if ($cnt) { $changed = 1; print $REP "$r:$ln:$cls:$cnt\n"; }
          }
          $hash_lines{$ln} = 1 if $pc->[0] =~ $HASHLIKE;
          $branch_lines{$ln} = 1 if $pc->[0] =~ $BRANCHLIKE;
          while ($pc->[0] =~ /$BRANCHTICK/g) { $branch_lines{$ln} = 1 unless -e "$root/$1" || -e "$root/$1.md"; }
          $soft_lines{$ln} = 1 if $pc->[0] =~ $SOFTID;
        } else {
          for my $rule (@rules) {
            my ($cls, $re) = @$rule;
            print $MAN "$r:$ln:$cls (in code or data; NOT changed: a replacement could alter behaviour)\n"
              if $pc->[0] =~ $re && !$code_seen{"$ln:$cls"}++;
          }
        }
      }
      push @out, join('', map { $_->[0] } @pieces);
    }
    if (%hash_lines) {
      my @l = sort { $a <=> $b } keys %hash_lines;
      print $MAN "$r:$l[0]:commit-hash-like tokens in text on lines " . join(',', @l) . " (could point at the public fork)\n";
    }
    if (%branch_lines) {
      my @l = sort { $a <=> $b } keys %branch_lines;
      print $MAN "$r:$l[0]:branch-name-like tokens on lines " . join(',', @l) . "\n";
    }
    if (%soft_lines) {
      my @l = sort { $a <=> $b } keys %soft_lines;
      print $MAN "$r:$l[0]:soft-identity wording (supervisor/course/university) on lines " . join(',', @l) . "\n";
    }
    if ($r =~ /\.md$/i) {
      my %broken; my $n2 = 0; my $dir = $f; $dir =~ s{/[^/]*$}{};
      for my $line (@out) {
        $n2++;
        while ($line =~ /\]\(([^)\s#]+)(?:#[^)]*)?\)/g) {
          my $t = $1; next if $t =~ m{^[a-z]+:}i;
          $broken{$n2} = 1 unless -e "$dir/$t";
        }
      }
      if (%broken) {
        my @l = sort { $a <=> $b } keys %broken;
        print $MAN "$r:$l[0]:relative links to files not in the artifact on lines " . join(',', @l) . "\n";
      }
    }
    if ($changed) {
      open(my $fh, '>:raw', $f) or die "write $f: $!\n"; print $fh @out; close $fh;
    }
  }
  close $REP; close $MAN;
  exit 0;
}

if ($mode eq 'check') {
  my ($allowf) = @rest;
  my %allow;
  if ($allowf && -f $allowf) {
    for (read_lines($allowf)) { chomp; s/\s+#.*$//; next unless /\S/; $allow{$_} = 1; }
  }
  my $found = 0;
  my $emit = sub { my $s = shift; return if $allow{$s}; print "$s\n"; $found++; };
  for my $f (files()) {
    my $r = rel($f);
    my @parts = split m{/}, $r;
    for my $p (@parts) {
      if ($p =~ /^(?:\.env.*|.*\.log|node_modules|\.git|results-.*|.*\.pem|.*\.key|id_rsa.*|\.DS_Store|__pycache__)$/) {
        $emit->("$r:0:forbidden-file"); last;
      }
    }
    next if -B $f;
    my $ln = 0;
    for my $line (read_lines($f)) {
      $ln++;
      my %c;
      for my $rule (@rules) { $c{$rule->[0]} = 1 if $line =~ $rule->[1]; }
      $c{$_} = 1 for grep { !/-fixture$/ } secret_classes($line);
      $emit->("$r:$ln:$_") for sort keys %c;
    }
  }
  exit($found ? 1 : 0);
}

die "unknown mode: $mode\n";
