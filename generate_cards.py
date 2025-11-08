#!/usr/bin/env python3
# Non-AI heuristic card generator: headings + bullets → basic/cloze-like cards.
import sys, re, csv, pathlib
HEAD_KEYS = ['definition','theorem','lemma','proposition','corollary','axiom','property','rule']
BULLET_RE = re.compile(r'^\s*([-*•]|\d+[.)])\s+(.*)$', re.IGNORECASE)
HEAD_RE = re.compile(r'^(#+\s+)?(' + '|'.join([k.capitalize() for k in HEAD_KEYS]) + r')\b[:\s-]*(.*)$')
def read_text(path): return pathlib.Path(path).read_text(encoding='utf-8', errors='ignore')
def split_blocks(text):
    blocks, cur = [], []
    for line in text.splitlines():
        if line.strip()=='':
            if cur: blocks.append("\n".join(cur)); cur=[]
        else: cur.append(line.rstrip())
    if cur: blocks.append("\n".join(cur)); return blocks
def extract_pairs(text):
    cards=[]; blocks=split_blocks(text)
    for block in blocks:
        first = block.strip().splitlines()[0]
        m = HEAD_RE.match(first)
        if m:
            kind=m.group(2).strip(); tail=m.group(3).strip() or 'this item'
            q = "Define " + tail + "." if kind.lower()=="definition" else f"State the {kind.lower()} {tail}."
            cards.append((q, block.strip(), kind.lower())); continue
        lines=block.splitlines(); ms=[BULLET_RE.match(l) for l in lines]
        if all(ms):
            for m in ms:
                text=m.group(2).strip()
                if ':' in text:
                    head,desc=text.split(':',1); q=head.strip()+'?'; a=desc.strip()
                else:
                    q=f"Explain: {text}"; a=text
                cards.append((q,a,'bullet'))
    return cards
def main():
    if len(sys.argv)<3:
        print("Usage: generate_cards.py input.md output.csv [--tag tag]"); sys.exit(1)
    in_path, out_path = sys.argv[1], sys.argv[2]; tag=None
    if '--tag' in sys.argv:
        i=sys.argv.index('--tag'); 
        if i+1 < len(sys.argv): tag=sys.argv[i+1]
    text=read_text(in_path); pairs=extract_pairs(text)
    with open(out_path,'w',newline='',encoding='utf-8') as f:
        w=csv.writer(f); w.writerow(['front','back','tags'])
        for q,a,t in pairs: w.writerow([q,a, tag or t])
    print(f"Wrote {len(pairs)} cards to {out_path}")
if __name__=='__main__': main()
