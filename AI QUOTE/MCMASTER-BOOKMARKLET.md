# McMaster One-Click Capture Bookmarklet

One-time install. While on any McMaster product page, click the bookmarklet → it grabs part #, price, availability, description, and drawing URL from the page and copies a JSON blob to your clipboard. Switch to AI Quote → open Smart Paste → paste → Apply.

> **The simpler way first:** McMaster has a built-in option that does most of this without a bookmarklet. Go to your McMaster account → **Settings** → **Copy and paste settings** → pick **"Formatted for copying and pasting"** → Save. Then when you select + copy a Product Detail box on any product page, it pastes as a clean 3-line block: `part #` / `description` / `price per pack of N`. AI Quote's Smart Paste parser handles that format directly — no bookmarklet needed. The bookmarklet below is still useful when you want a one-click capture that also includes the drawing URL.

## Install (one-time)

1. Show your Chrome bookmarks bar if it's hidden: `Ctrl+Shift+B`
2. Right-click the bookmarks bar → **Add page…**
3. **Name**: `McMaster → AI Quote`
4. **URL**: paste the entire single line below (starts with `javascript:`)
5. Save.

```
javascript:(function(){var u=location.href;var pn=(u.match(/mcmaster\.com\/([0-9][0-9A-Z]{3,8})/i)||[])[1]||null;var pr=null,av=null,desc=null,dr=null;try{var s=document.querySelectorAll('script[type="application/ld+json"]');for(var i=0;i<s.length;i++){var ld;try{ld=JSON.parse(s[i].textContent);}catch(e){continue;}var it=Array.isArray(ld)?ld:[ld];for(var j=0;j<it.length;j++){var x=it[j];if(x&&x['@type']&&(''+x['@type']).indexOf('Product')>=0){if(x.name&&!desc)desc=x.name;if(x.offers){var o=Array.isArray(x.offers)?x.offers[0]:x.offers;if(o.price&&!pr)pr=parseFloat(o.price);if(o.availability&&!av)av=(''+o.availability).replace(/^https?:\/\/schema\.org\//,'');}}}}}catch(e){}var bt=(document.body.innerText||'').slice(0,8000);if(!pr){var pm=bt.match(/\$\s*([0-9,]+\.\d{2})\s*(?:each|ea\.?|per\s*pack|per\s*100|\/\s*100|per\s*foot|\/\s*ft|per\s*lb|\/\s*lb)?/i);if(pm)pr=parseFloat(pm[1].replace(/,/g,''));}if(!av){var am=bt.match(/usually\s+ships?[^\n]{0,40}|ships?\s+today|in\s+stock|backordered|out\s+of\s+stock/i);if(am)av=am[0].trim();}if(!desc)desc=(document.title||'').split('|')[0].trim().slice(0,140);var dl=document.querySelectorAll('a[href*=".pdf"]');for(var k=0;k<dl.length;k++){var h=dl[k].href;if(h&&/pdf|datasheet|drawing|cad/i.test(h+' '+(dl[k].textContent||''))){dr=h;break;}}var d={__source:'mcmaster-bookmarklet',partNum:pn,price:pr,priceUnit:'each',availability:av,url:u,description:desc,drawingUrl:dr,capturedAt:new Date().toISOString()};var j=JSON.stringify(d);if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(j).then(function(){alert('Captured:\nPart: '+(pn||'?')+'\nPrice: $'+(pr||'?')+'\n\nNow paste into AI Quote Smart Paste.');},function(){prompt('Copy manually:',j);});}else{prompt('Copy manually:',j);}})();
```

## Use

1. While logged into McMaster, navigate to any product page (the URL ends in `/12345K67/` or similar).
2. Click the **McMaster → AI Quote** bookmark.
3. A confirmation popup shows: `Captured: Part: 1388K11, Price: $42.18`.
4. Switch tabs to AI Quote → open a quote → on the part you're pricing, scroll to Material section → click **📋 Open Smart Paste**.
5. Ctrl+V into the textarea. The green "✓ Bookmarklet JSON detected" panel appears.
6. Click **Apply →**. Part #, price, URL, vendor link all fill in automatically.

## What it captures

| Field | Source on the McMaster page |
|---|---|
| Part # | URL path (always reliable) |
| Price | Schema.org JSON-LD if present, falls back to `$X.XX` text |
| Availability | "Ships today", "Usually ships in N days", "In stock" etc. |
| Description | Schema.org product name, falls back to page title |
| Drawing URL | First `.pdf` link with "drawing", "datasheet", or "pds" in the URL or label |
| Source URL | The current page URL |

The capture is best-effort — McMaster's HTML structure changes occasionally. If a field is missing, you can always fall back to the existing text-only Smart Paste (just Ctrl+A → Ctrl+C the page, paste into the textarea, the same parser runs on raw text).

## When the real API ships

This bookmarklet becomes redundant — the API will fill the same fields automatically based on a search query, with no copy-paste step. Until then, this is the fastest manual workflow.

## Source (un-minified for reference)

```javascript
javascript:(function(){
  var u = location.href;
  var pn = (u.match(/mcmaster\.com\/([0-9][0-9A-Z]{3,8})/i) || [])[1] || null;
  var pr = null, av = null, desc = null, dr = null;

  // Try schema.org JSON-LD first (cleanest source)
  try {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      var ld;
      try { ld = JSON.parse(scripts[i].textContent); } catch(e) { continue; }
      var items = Array.isArray(ld) ? ld : [ld];
      for (var j = 0; j < items.length; j++) {
        var x = items[j];
        if (x && x['@type'] && (''+x['@type']).indexOf('Product') >= 0) {
          if (x.name && !desc) desc = x.name;
          if (x.offers) {
            var o = Array.isArray(x.offers) ? x.offers[0] : x.offers;
            if (o.price && !pr) pr = parseFloat(o.price);
            if (o.availability && !av) av = (''+o.availability).replace(/^https?:\/\/schema\.org\//, '');
          }
        }
      }
    }
  } catch(e) {}

  // Fall back to visible text parsing
  var bodyText = (document.body.innerText || '').slice(0, 8000);
  if (!pr) {
    var pm = bodyText.match(/\$\s*([0-9,]+\.\d{2})\s*(?:each|ea\.?|per\s*pack|per\s*100|\/\s*100|per\s*foot|\/\s*ft|per\s*lb|\/\s*lb)?/i);
    if (pm) pr = parseFloat(pm[1].replace(/,/g, ''));
  }
  if (!av) {
    var am = bodyText.match(/usually\s+ships?[^\n]{0,40}|ships?\s+today|in\s+stock|backordered|out\s+of\s+stock/i);
    if (am) av = am[0].trim();
  }
  if (!desc) desc = (document.title || '').split('|')[0].trim().slice(0, 140);

  // Find a drawing/datasheet PDF link
  var drawLinks = document.querySelectorAll('a[href*=".pdf"]');
  for (var k = 0; k < drawLinks.length; k++) {
    var href = drawLinks[k].href;
    if (href && /pdf|datasheet|drawing|cad/i.test(href + ' ' + (drawLinks[k].textContent || ''))) {
      dr = href; break;
    }
  }

  var data = {
    __source: 'mcmaster-bookmarklet',
    partNum: pn,
    price: pr,
    priceUnit: 'each',
    availability: av,
    url: u,
    description: desc,
    drawingUrl: dr,
    capturedAt: new Date().toISOString(),
  };

  var json = JSON.stringify(data);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(json).then(
      function() { alert('Captured:\nPart: ' + (pn||'?') + '\nPrice: $' + (pr||'?') + '\n\nNow paste into AI Quote Smart Paste.'); },
      function() { prompt('Copy manually:', json); }
    );
  } else {
    prompt('Copy manually:', json);
  }
})();
```
