#!/usr/bin/env python3
"""
fetch_brokers.py — Pobiera listy dostępnych ETF/ETC/ETN od brokerów

Źródła:
  - XTB:   PDF "Tabela Specyfikacji Instrumentów Finansowych Rynku Zorganizowanego (OMI)"
           strona: https://www.xtb.com/pl/specyfikacja-instrumentow/dokumenty
  - BOSSA: PDF "Lista wszystkich instrumentów zagranicznych"
           strona: https://bossa.pl/oferta/rynek-zagraniczny/kid

Polskie ETF-y (source='atlasetf') zawsze dostępne u obu brokerów.

Wynik: NDJSON na stdout
  {"broker": "xtb",   "isin": "IE00B4L5Y983"}
  {"broker": "bossa", "isin": "IE00B4L5Y983"}
"""
import sys, json, re, io, os, urllib.request
from datetime import datetime

try:
    from bs4 import BeautifulSoup
    BS4_OK = True
except ImportError:
    BS4_OK = False
    print("[WARN] beautifulsoup4 nie zainstalowany — użycie fallback regex", file=sys.stderr)

try:
    import pypdf
    PYPDF_OK = True
except ImportError:
    PYPDF_OK = False
    print("[WARN] pypdf nie zainstalowany — brak parsowania PDF", file=sys.stderr)

ISIN_RE = re.compile(r'([A-Z]{2}[A-Z0-9]{9}[0-9])')
UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

# ── HTTP ──────────────────────────────────────────────────────────────────────

def fetch_url(url: str, binary: bool = False):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read() if binary else r.read().decode('utf-8', errors='replace')

# ── PDF ───────────────────────────────────────────────────────────────────────

def extract_isins_from_pdf(data: bytes) -> set[str]:
    """Wyciąga ISINy z treści PDF przez pypdf."""
    if not PYPDF_OK:
        return set()
    try:
        reader = pypdf.PdfReader(io.BytesIO(data))
        text = ''
        for page in reader.pages:
            try:
                text += (page.extract_text(extraction_mode="plain") or '')
            except Exception:
                try:
                    text += (page.extract_text() or '')
                except Exception:
                    continue
        found = set(ISIN_RE.findall(text))
        return found
    except Exception as e:
        print(f"[PDF] Błąd parsowania: {e}", file=sys.stderr)
        return set()

# ── HTML — szukanie linku PDF ─────────────────────────────────────────────────

def find_pdf_href(html: str, keywords: list[str], base_url: str) -> str | None:
    """
    Szuka pierwszego linka do PDF który zawiera któreś ze słów kluczowych.
    Odporny na zmiany struktury HTML — używa BeautifulSoup (lub regex jako fallback).
    Zwraca absolutny URL.
    """
    candidates = []

    if BS4_OK:
        soup = BeautifulSoup(html, 'html.parser')
        for a in soup.find_all('a', href=True):
            href = a['href']
            text = a.get_text(separator=' ', strip=True)
            if not href:
                continue
            # Dopasuj po słowach kluczowych w tekście linka
            for kw in keywords:
                if kw.lower() in text.lower():
                    candidates.append((href, text))
                    break
    else:
        # Fallback: regex
        for m in re.finditer(r'href="([^"]+)"[^>]*>([^<]+)', html):
            href, text = m.group(1), m.group(2)
            for kw in keywords:
                if kw.lower() in text.lower():
                    candidates.append((href, text))
                    break

    if not candidates:
        return None

    # Weź pierwszego kandydata i uczyń URL absolutnym
    href = candidates[0][0]
    if href.startswith('http'):
        return href
    # Wyciągnij origin z base_url
    from urllib.parse import urljoin
    return urljoin(base_url, href)

# ── XTB ───────────────────────────────────────────────────────────────────────

XTB_DOCS_URL = 'https://www.xtb.com/pl/specyfikacja-instrumentow/dokumenty'
XTB_KEYWORDS = [
    'Rynku Zorganizowanego (OMI)',
    'OMI',
    'Instrumentów Finansowych Rynku Zorganizowanego',
    'omi-specification',
    'omi specification',
]

def fetch_xtb_isins() -> set[str]:
    print("[XTB] Pobieranie strony dokumentów...", file=sys.stderr)
    try:
        html = fetch_url(XTB_DOCS_URL)
        pdf_url = find_pdf_href(html, XTB_KEYWORDS, XTB_DOCS_URL)
        if not pdf_url:
            print("[XTB] Nie znaleziono linku do PDF OMI — próba fallback po href", file=sys.stderr)
            # Fallback: szukaj omi w href bezpośrednio
            m = re.search(r'href="([^"]*omi[^"]*\.pdf)"', html, re.IGNORECASE)
            if m:
                pdf_url = m.group(1)
                if not pdf_url.startswith('http'):
                    pdf_url = 'https://www.xtb.com' + pdf_url
        if not pdf_url:
            print("[XTB] Nie znaleziono linku do PDF", file=sys.stderr)
            return set()
        print(f"[XTB] Pobieranie PDF: {pdf_url}", file=sys.stderr)
        pdf_data = fetch_url(pdf_url, binary=True)
        isins = extract_isins_from_pdf(pdf_data)
        print(f"[XTB] Znaleziono {len(isins)} ISINów", file=sys.stderr)
        return isins
    except Exception as e:
        print(f"[XTB] Błąd: {e}", file=sys.stderr)
        return set()

# ── BOSSA ─────────────────────────────────────────────────────────────────────

BOSSA_KID_URL = 'https://bossa.pl/oferta/rynek-zagraniczny/kid'
BOSSA_KEYWORDS = [
    'Lista wszystkich instrumentów zagranicznych',
    'instrumentów zagranicznych',
    'lista instrumentów',
    'wszystkich instrumentow',
]

def fetch_bossa_isins() -> set[str]:
    print("[BOSSA] Pobieranie strony dokumentów...", file=sys.stderr)
    try:
        html = fetch_url(BOSSA_KID_URL)
        pdf_url = find_pdf_href(html, BOSSA_KEYWORDS, BOSSA_KID_URL)
        if not pdf_url:
            print("[BOSSA] Nie znaleziono linku do PDF — próba fallback", file=sys.stderr)
            m = re.search(r'href="([^"]*Lista_wszystkich[^"]*\.pdf)"', html, re.IGNORECASE)
            if m:
                pdf_url = m.group(1)
                if not pdf_url.startswith('http'):
                    pdf_url = 'https://bossa.pl' + pdf_url
        if not pdf_url:
            print("[BOSSA] Nie znaleziono linku do PDF", file=sys.stderr)
            return set()
        print(f"[BOSSA] Pobieranie PDF: {pdf_url}", file=sys.stderr)
        pdf_data = fetch_url(pdf_url, binary=True)
        isins = extract_isins_from_pdf(pdf_data)
        print(f"[BOSSA] Znaleziono {len(isins)} ISINów", file=sys.stderr)
        return isins
    except Exception as e:
        print(f"[BOSSA] Błąd: {e}", file=sys.stderr)
        return set()

# ── Polskie ETF-y z bazy ──────────────────────────────────────────────────────

def fetch_pl_isins() -> set[str]:
    """Polskie ETF-y (source='atlasetf') — zawsze dostępne u obu brokerów."""
    try:
        import sqlite3
        db_path = os.environ.get('DATA_DIR', '/app/data') + '/momentum.db'
        con = sqlite3.connect(db_path)
        rows = con.execute("SELECT isin FROM etfs WHERE source='atlasetf'").fetchall()
        con.close()
        return {r[0] for r in rows}
    except Exception as e:
        print(f"[PL] Błąd pobierania z bazy: {e}", file=sys.stderr)
        return set()

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    pl_isins = fetch_pl_isins()
    print(f"[PL] {len(pl_isins)} polskich ETF-ów (zawsze dostępne)", file=sys.stderr)

    xtb_isins   = fetch_xtb_isins()
    bossa_isins = fetch_bossa_isins()

    # Polskie ETF-y zawsze dostępne u obu brokerów
    xtb_isins   = xtb_isins   | pl_isins
    bossa_isins = bossa_isins | pl_isins

    for isin in sorted(xtb_isins):
        print(json.dumps({'broker': 'xtb', 'isin': isin}, ensure_ascii=False))
    for isin in sorted(bossa_isins):
        print(json.dumps({'broker': 'bossa', 'isin': isin}, ensure_ascii=False))

    print(f"[DONE] XTB: {len(xtb_isins)}, BOSSA: {len(bossa_isins)}", file=sys.stderr)

if __name__ == '__main__':
    main()
