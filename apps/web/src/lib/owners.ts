export const ownerColorPalette = [
  { active: 'bg-blue-500/20 text-blue-400 border-blue-500/30', inactive: 'text-slate-500 border-border hover:text-blue-400 hover:border-blue-500/20' },
  { active: 'bg-purple-500/20 text-purple-400 border-purple-500/30', inactive: 'text-slate-500 border-border hover:text-purple-400 hover:border-purple-500/20' },
  { active: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', inactive: 'text-slate-500 border-border hover:text-emerald-400 hover:border-emerald-500/20' },
  { active: 'bg-amber-500/20 text-amber-400 border-amber-500/30', inactive: 'text-slate-500 border-border hover:text-amber-400 hover:border-amber-500/20' },
  { active: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30', inactive: 'text-slate-500 border-border hover:text-cyan-400 hover:border-cyan-500/20' },
];

export function buildOwnerColors(options: string[]) {
  const map: Record<string, (typeof ownerColorPalette)[0]> = {};
  options.forEach((o, i) => {
    map[o] = ownerColorPalette[i % ownerColorPalette.length];
  });
  return map;
}
