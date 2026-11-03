// Small host-owned line icons; no font glyph or external asset dependency.
export function Icon({name}:{name:'sidebar'|'compose'|'team'|'folder'|'plus'}) {
 const paths={sidebar:'M8 3v18M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2',compose:'m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6',team:'M8 8h8v8H8zM12 2v6M12 16v6M2 12h6M16 12h6M4 4l4 4M16 16l4 4M4 20l4-4M16 8l4-4',folder:'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 7h16a2 2 0 0 1 2 2l-2 10H5L3 7',plus:'M12 5v14M5 12h14'}
 return <svg className="sa-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>
}
