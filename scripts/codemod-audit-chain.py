#!/usr/bin/env python3
"""
Task 33-c codemod: doda tamper-evident chain polja (previousHash/chainHash) na VSE
db.auditLog.create / tx.auditLog.create site-e IZVEN src/app/api/orders/** in src/lib/ops.ts.

Za vsak site (minimalen diff — ohrani formatiranje in komentarje):
  - izlušči data polja (id/action/entityType/entityId/details/locationId)
  - pred create vrstico vstavi:
      const __chainN = await auditChainFields(<client>, { action, entityType, entityId, details?, locationId?, id })
    (če je id inline `nid()`, ga hoistira: const __aIdN = nid(); ... in v data zamenja)
  - v data takoj za `data: {` vstavi `...__chainN,`
  - doda import { auditChainFields } from '@/lib/audit-chain'
"""
import os
import re

ROOT = '/home/z/my-project'
EXCLUDE = [
    os.path.join(ROOT, 'src', 'app', 'api', 'orders'),
    os.path.join(ROOT, 'src', 'lib', 'ops.ts'),
]

def excluded(path):
    for e in EXCLUDE:
        if path == e or path.startswith(e + os.sep):
            return True
    return False

def find_matching(src, open_idx):
    opens = {'{': '}', '(': ')', '[': ']'}
    close_to_open = {v: k for k, v in opens.items()}
    stack = [src[open_idx]]
    i = open_idx + 1
    n = len(src)
    while i < n and stack:
        c = src[i]
        if c in ('"', "'", '`'):
            quote = c
            i += 1
            while i < n:
                if src[i] == '\\':
                    i += 2
                    continue
                if src[i] == quote:
                    break
                i += 1
        elif c in opens:
            stack.append(c)
        elif c in close_to_open:
            if stack and stack[-1] == close_to_open[c]:
                stack.pop()
                if not stack:
                    return i
        i += 1
    return -1

def split_top_level(s):
    parts = []
    depth = 0
    cur = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c in ('"', "'", '`'):
            cur.append(c)
            i += 1
            while i < n:
                cur.append(s[i])
                if s[i] == '\\':
                    i += 2
                    if i < n:
                        cur.append(s[i])
                    continue
                if s[i] == c:
                    break
                i += 1
            i += 1
            continue
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        if c == ',' and depth == 0:
            parts.append(''.join(cur))
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    if ''.join(cur).strip():
        parts.append(''.join(cur))
    return parts

FIELD_RE = re.compile(r'^\s*(\w+)\s*:\s*([\s\S]+)$', re.S)

def normalize(expr):
    return re.sub(r'\s+', ' ', expr.strip().rstrip(','))

report = {'files': 0, 'sites': 0, 'hoisted': 0, 'skipped': []}

targets = []
for base in (os.path.join(ROOT, 'src/app/api'), os.path.join(ROOT, 'src/lib')):
    for dirpath, dirnames, filenames in os.walk(base):
        for fn in filenames:
            if fn.endswith(('.ts', '.tsx')):
                targets.append(os.path.join(dirpath, fn))

for path in sorted(targets):
    if excluded(path):
        continue
    with open(path, 'r', encoding='utf-8') as f:
        src = f.read()
    if 'auditLog.create' not in src or 'auditChainFields' in src:
        continue

    pattern = re.compile(r'\b(db|tx|dbx)\.auditLog\.create\(\{')
    matches = list(pattern.finditer(src))
    if not matches:
        continue

    edits = []  # dicts with spans (all relative to ORIGINAL src)
    chain_no = 0
    for m in matches:
        client = m.group(1)
        brace_open = src.index('{', m.end() - 1)
        brace_close = find_matching(src, brace_open)
        if brace_close == -1:
            report['skipped'].append((path, 'no-match-brace', m.start()))
            continue
        inner = src[brace_open + 1:brace_close]
        dm = re.search(r'\bdata\s*:\s*\{', inner)
        if not dm:
            report['skipped'].append((path, 'no-data-object', m.start()))
            continue
        data_open = brace_open + 1 + dm.end() - 1
        data_close = find_matching(src, data_open)
        if data_close == -1:
            report['skipped'].append((path, 'no-data-close', m.start()))
            continue
        data_body = src[data_open + 1:data_close]

        fields = {}
        parse_ok = True
        for part in split_top_level(data_body):
            fm = FIELD_RE.match(part)
            if not fm:
                if part.strip():
                    parse_ok = False
                    break
                continue
            fields[fm.group(1)] = normalize(fm.group(2))
        if not parse_ok:
            report['skipped'].append((path, 'unparsed-field', m.start()))
            continue
        missing = [r for r in ('id', 'action', 'entityType', 'entityId') if r not in fields]
        if missing:
            report['skipped'].append((path, f'missing-{missing[0]}', m.start()))
            continue

        chain_no += 1
        chain_var = f'__chain{chain_no}'
        id_expr = fields['id']
        hoist_var = None
        if id_expr == 'nid()':
            chain_no += 1  # porabi številko za id/chain par
            hoist_var = f'__aId{chain_no}'
            chain_var = f'__chain{chain_no}'
            report['hoisted'] += 1

        opts = [f"action: {fields['action']}", f"entityType: {fields['entityType']}", f"entityId: {fields['entityId']}"]
        if 'details' in fields:
            opts.append(f"details: {fields['details']}")
        if 'locationId' in fields:
            opts.append(f"locationId: {fields['locationId']}")
        opts.append(f"id: {hoist_var if hoist_var else id_expr}")
        chain_stmt = (f"const {hoist_var} = nid(); " if hoist_var else '') + \
            f"const {chain_var} = await auditChainFields({client}, {{ {', '.join(opts)} }})"

        # nova data body: vstavi ...chain Na ZAČETEK + zamenjaj id, če hoist
        body = data_body
        if hoist_var:
            # zamenjaj SAMO prvo pojavnost polja id: nid()
            body = re.sub(r'(\bid\s*:\s*)nid\(\)', rf'\g<1>{hoist_var}', body, count=1)
        new_body = f' ...{chain_var},' + body

        line_start = src.rfind('\n', 0, m.start()) + 1
        indent = re.match(r'[ \t]*', src[line_start:]).group(0)
        # ohrani prefix stavka (npr. 'await ' ali 'const log = await ') — vstavi chain vrstico PRED njim
        prefix = src[line_start:m.start()]

        edits.append({
            'data': (data_open + 1, data_close, new_body),
            'line': (line_start, m.start(), f'{indent}{chain_stmt}\n{prefix}'),
        })

    # uporabi od zadaj naprej (višji offseti prej)
    all_spans = []
    for e in edits:
        all_spans.append((e['data'][0], e['data'][1], e['data'][2]))
        all_spans.append((e['line'][0], e['line'][1], e['line'][2]))
    for start, end, repl in sorted(all_spans, key=lambda x: -x[0]):
        src = src[:start] + repl + src[end:]

    if "from '@/lib/audit-chain'" not in src:
        lines = src.split('\n')
        last_import = 0
        for i, line in enumerate(lines):
            if re.match(r'^import\b', line) or re.match(r'^} from ', line):
                last_import = i
        lines.insert(last_import + 1, "import { auditChainFields } from '@/lib/audit-chain'")
        src = '\n'.join(lines)

    with open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    report['files'] += 1
    report['sites'] += len(edits)

print(f"files modified: {report['files']}")
print(f"sites converted: {report['sites']}")
print(f"ids hoisted: {report['hoisted']}")
for s in report['skipped']:
    print('SKIPPED:', s)
