import * as path from 'path';

/**
 * 仓库画像使用的语言注册表。
 *
 * 这里不做语法解析器级别的承诺；它负责把扩展名/入口文件归一化，
 * 让不同语言走同一套安全扫描、分块、证据和面试材料流水线。
 */
export interface LanguageSpec {
  id: string;
  extensions: readonly string[];
  filenames?: readonly string[];
}

export interface LanguageStat {
  files: number;
  loc: number;
  extensions: string[];
}

const SPECS: readonly LanguageSpec[] = [
  { id: 'TypeScript', extensions: ['.ts', '.tsx', '.mts', '.cts'] },
  { id: 'JavaScript', extensions: ['.js', '.jsx', '.mjs', '.cjs'] },
  { id: 'Python', extensions: ['.py', '.pyw'] },
  { id: 'Go', extensions: ['.go'] },
  { id: 'Java', extensions: ['.java'] },
  { id: 'Kotlin', extensions: ['.kt', '.kts'] },
  { id: 'Rust', extensions: ['.rs'] },
  { id: 'C', extensions: ['.c', '.h'] },
  { id: 'C++', extensions: ['.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'] },
  { id: 'C#', extensions: ['.cs'] },
  { id: 'F#', extensions: ['.fs', '.fsi', '.fsx', '.fsscript'] },
  { id: 'Visual Basic', extensions: ['.vb', '.vbs'] },
  { id: 'Ruby', extensions: ['.rb', '.rake', '.gemspec'] },
  { id: 'PHP', extensions: ['.php', '.phtml'] },
  { id: 'Swift', extensions: ['.swift'] },
  { id: 'Objective-C', extensions: ['.m', '.mm'] },
  { id: 'Dart', extensions: ['.dart'] },
  { id: 'Scala', extensions: ['.scala', '.sc'] },
  { id: 'Groovy', extensions: ['.groovy', '.gradle'] },
  { id: 'Elixir', extensions: ['.ex', '.exs'] },
  { id: 'Erlang', extensions: ['.erl', '.hrl'] },
  { id: 'Clojure', extensions: ['.clj', '.cljs', '.cljc', '.edn'] },
  { id: 'Lua', extensions: ['.lua'] },
  { id: 'R', extensions: ['.r', '.Rmd'] },
  { id: 'Julia', extensions: ['.jl'] },
  { id: 'Haskell', extensions: ['.hs', '.lhs'] },
  { id: 'Zig', extensions: ['.zig'] },
  { id: 'Nim', extensions: ['.nim', '.nims'] },
  { id: 'Perl', extensions: ['.pl', '.pm', '.t'] },
  { id: 'Solidity', extensions: ['.sol'] },
  { id: 'SQL', extensions: ['.sql', '.pgsql', '.mysql'] },
  { id: 'Shell', extensions: ['.sh', '.bash', '.zsh', '.fish'] },
  { id: 'PowerShell', extensions: ['.ps1', '.psm1', '.psd1'] },
  { id: 'Batch', extensions: ['.bat', '.cmd'] },
  { id: 'HTML', extensions: ['.html', '.htm'] },
  { id: 'CSS', extensions: ['.css', '.scss', '.sass', '.less'] },
  { id: 'Vue', extensions: ['.vue'] },
  { id: 'Svelte', extensions: ['.svelte'] },
  { id: 'Astro', extensions: ['.astro'] },
  { id: 'GraphQL', extensions: ['.graphql', '.gql'] },
  { id: 'Protocol Buffers', extensions: ['.proto'] },
  { id: 'Terraform/HCL', extensions: ['.tf', '.tfvars', '.hcl'] },
  { id: 'JSON', extensions: ['.json', '.jsonc'] },
  { id: 'YAML', extensions: ['.yaml', '.yml'] },
  { id: 'TOML', extensions: ['.toml'] },
  { id: 'XML', extensions: ['.xml', '.xsd', '.plist'] },
  { id: 'Markdown', extensions: ['.md', '.mdx'] },
  { id: 'Dockerfile', extensions: [], filenames: ['dockerfile'] },
  { id: 'Makefile', extensions: [], filenames: ['makefile', 'gnumakefile'] },
  { id: 'CMake', extensions: [], filenames: ['cmakelists.txt'] },
  { id: 'Plain text', extensions: ['.txt', '.text', '.log'] },
];

const BY_EXTENSION = new Map<string, string>();
const BY_FILENAME = new Map<string, string>();
for (const spec of SPECS) {
  for (const ext of spec.extensions) BY_EXTENSION.set(ext.toLowerCase(), spec.id);
  for (const filename of spec.filenames ?? []) BY_FILENAME.set(filename.toLowerCase(), spec.id);
}

export function languageForPath(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  const base = path.posix.basename(normalized).toLowerCase();
  return BY_FILENAME.get(base) ?? BY_EXTENSION.get(path.posix.extname(base).toLowerCase()) ?? 'Other';
}

/** 是否应作为可精读的源码/标记/基础设施文件参与候选补位。 */
export function isSourceLikePath(file: string): boolean {
  const base = path.posix.basename(file.replace(/\\/g, '/')).toLowerCase();
  return BY_FILENAME.has(base) || BY_EXTENSION.has(path.posix.extname(base).toLowerCase());
}

export function languageStatsFor(files: string[], contents: Map<string, string>, countLines: (content: string) => number): Record<string, LanguageStat> {
  const out: Record<string, LanguageStat> = {};
  for (const file of files) {
    const language = languageForPath(file);
    const slot = (out[language] ??= { files: 0, loc: 0, extensions: [] });
    slot.files++;
    slot.loc += countLines(contents.get(file) ?? '');
    const ext = path.posix.extname(file.replace(/\\/g, '/')).toLowerCase() || path.posix.basename(file).toLowerCase();
    if (!slot.extensions.includes(ext)) slot.extensions.push(ext);
  }
  return out;
}

export function supportedLanguageNames(): string[] {
  return SPECS.map((spec) => spec.id);
}
