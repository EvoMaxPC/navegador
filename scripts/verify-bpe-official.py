#!/usr/bin/env python3
"""Comparación independiente con OpenAI tiktoken 0.12.0; no requiere red.
Uso: python scripts/verify-bpe-official.py [ruta/informe.json]
Instalar antes: python -m pip install tiktoken==0.12.0
Los .tiktoken de npm se usan sólo si su SHA coincide con el hash oficial que
verifica tiktoken_ext.openai_public. El algoritmo de referencia es el Rust de OpenAI.
"""
import hashlib, importlib.metadata, json, os, pathlib, random, subprocess, sys, tempfile
import tiktoken
ROOT = pathlib.Path(__file__).resolve().parents[1]
if importlib.metadata.version('tiktoken') != '0.12.0':
    raise RuntimeError('Se requiere tiktoken==0.12.0 para reproducir este informe')
MODELS = json.loads((ROOT/'src/core/bpe-models.json').read_text())['models']
# URLs originales utilizadas por el registro oficial de tiktoken y hashes fijados por OpenAI.
HASHES = {
 'cl100k_base':'223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7',
 'o200k_base':'446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d',
 'p50k_base':'94b5ca7dff4d00767bc256fdd1b27e5b17361d7b8a5f968547f9f23eb70d2069',
 'r50k_base':'306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930',
}
CASES = [
 ('normal','Hola, mundo.'),('bordes','  Hola, mundo.  '),('espacios','uno    dos       tres'),
 ('saltos','primera\nsegunda\n\ntercera\n'),('CRLF','uno\r\ndos\r\n'),('tabulaciones','\tuno\tdos\t'),
 ('acentos','Árbol, café, pingüino, acción.'),('enye','Ñandú, niño, ¿¡€£¥©™!?'),
 ('emoji','Hola 😀🚀'),('emoji-combinado','👩🏽‍💻 👨‍👩‍👧‍👦 🇦🇷 ❤️'),('vacio',''),
 ('solo-espacios','   '),('solo-saltos','\n\n'),('solo-tabs','\t\t'),
 ('NFC','café'),('NFD','cafe\u0301'),('invisibles','a\u200bb\u00a0c\ufeff'),
 ('literal-especial','<|endoftext|> <|im_start|>'),('multilingue','你好世界 مرحبا بالعالم 日本語'),
 ('largo',('  Proyecto NEXO: acción, ñ, 👩🏽‍💻\tDatos exactos.\r\n')*180),
 ('repetido-1','Enviar lo mismo'),('repetido-2','Enviar lo mismo'),
 ('consecutivo-1','Primer mensaje'),('consecutivo-2','Segundo mensaje distinto'),
]
rng = random.Random(4678)
alphabet = list('aZ09 ñé\t\r\n<>|') + ['😀','👩🏽‍💻','\u0301','\u200b','你','ع']
CASES += [(f'fuzz-{i}', ''.join(rng.choice(alphabet) for _ in range(60))) for i in range(32)]
rows=[]
for encoding in sorted(set(MODELS.values())):
    representative = next(m for m,e in MODELS.items() if e == encoding)
    for name,text in CASES: rows.append({'case':name,'text':text,'encoding':encoding,'model':representative})
# Comprueba también la selección de encoding de TODOS los modelos de la tabla.
for model,encoding in MODELS.items():
    assert tiktoken.encoding_name_for_model(model) == encoding, model
    module = (ROOT/f'node_modules/gpt-tokenizer/cjs/model/{model}.js').read_text()
    assert f'../bpeRanks/{encoding}.js' in module, model
    rows.append({'case':'model-compatibility','text':'  Modelo: café 👩🏽‍💻\n','encoding':encoding,'model':model})
js = """
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(process.cwd()+'/package.json');
const {encodeGptText,countGptTokens,encodingForModel}=require('./src/core/gptTokens.cjs');
const rows=JSON.parse(readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(rows.map(r=>({...r,nexoIds:encodeGptText(r.text,r.model),nexo:countGptTokens(r.text,r.model),resolved:encodingForModel(r.model)}))));
"""
result = subprocess.run(['node','--input-type=module','-e',js],cwd=ROOT,input=json.dumps(rows),capture_output=True,text=True,check=True)
rows = json.loads(result.stdout)
with tempfile.TemporaryDirectory(prefix='nexo-official-tiktoken-') as cache:
    os.environ['TIKTOKEN_CACHE_DIR'] = cache
    for encoding,expected in HASHES.items():
        data = (ROOT/f'node_modules/gpt-tokenizer/data/{encoding}.tiktoken').read_bytes()
        assert hashlib.sha256(data).hexdigest() == expected, encoding
        url = f'https://openaipublic.blob.core.windows.net/encodings/{encoding}.tiktoken'
        (pathlib.Path(cache)/hashlib.sha1(url.encode()).hexdigest()).write_bytes(data)
    for row in rows:
        ids = tiktoken.get_encoding(row['encoding']).encode(row['text'],disallowed_special=())
        row['officialIds']=ids
        row['official']=len(ids)
        row['match']=row['nexo']==len(ids) and row['nexoIds']==ids and row['resolved']==row['encoding']
        row['textUtf8Sha256']=hashlib.sha256(row['text'].encode('utf-8')).hexdigest()
report={'formula':'T = length(encode_Em(S_original))','tiktoken':importlib.metadata.version('tiktoken'),
 'gpt-tokenizer':json.loads((ROOT/'node_modules/gpt-tokenizer/package.json').read_text())['version'],
 'specialTokenPolicy':'ordinary text; disallowed_special=() / disallowedSpecial=empty Set',
 'rankSha256':HASHES,'models':MODELS,'comparisons':len(rows),'discrepancies':sum(not r['match'] for r in rows),'rows':rows}
out = pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'docs/BPE-OFICIAL-COMPARACION.json'
out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(f"{len(rows)} comparaciones, {report['discrepancies']} discrepancias; {out}")
if report['discrepancies']: sys.exit(1)
