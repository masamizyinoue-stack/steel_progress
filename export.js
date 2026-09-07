// export.js — ファイル出力・エクスポート機能
// DXF Viewer V0_92
// 依存グローバル: cv, ov, doc, hiddenLayers, tx, ty, scale, bwMode, pdfImage, currentFileName (viewer.js)
//               draw, drawAnnotation, scheduleDraw, scheduleOverlay (viewer.js)
//               strokes, dims (var, HTML inline script)
//               hiddenLayers (layer.js)
//               rgbToAci, dxfEncText (utils.js)
//               showGuide, hideGuide (ui.js)
//               drawOverlay (HTML inline script)
// V0_141: PDF高画質化 — _pdfQualityDialog / savePDFBtn ハンドラ変更のみ
//   - PDF専用Canvas解像度: 画面Canvas × 倍率（2x/3x/4x 選択ダイアログ）
//   - デフォルト: 3x（高画質・推奨）
//   - メモリ安全: 4x→3x→2x 自動調整（500MB上限）
//   - PDF作成後に Canvas 解放（pdfCv/pdfOv/pdfAc/pdfComp を width=1 でメモリ返却）
// V0_92: PDF黒画面バグ修正
//   - LONG_PX: 8000→6000（iPad安全canvas範囲: ~25.5MP、513DPI for A4）
//   - 出力形式: PNG→JPEG 0.98（大容量PNG→jsPDF失敗の回避、高品質維持）
// V0_91: PDF最高解像度対応（LONG_PX=8000、PNG、try-finally）
// V0_147: スクショ機能削除

// =========================================================
// DXF書き出し（元データ + 書き込みストローク）
// =========================================================
function exportSketchDxf(){
  if(!doc&&(!strokes||strokes.length===0)){showGuide('データがありません',1500);return;}

  const layerSet=new Set(['SKETCH']);
  if(doc){
    for(const e of [...(doc.sen||[]),...(doc.enko||[]),...(doc.ten||[]),...(doc.moji||[])]){
      if(e.layer) layerSet.add(e.layer);
    }
  }

  const L=[];

  L.push('0','SECTION','2','HEADER',
    '9','$ACADVER','1','AC1009',
    '9','$INSUNITS','70','4',
    '0','ENDSEC');

  L.push('0','SECTION','2','TABLES',
    '0','TABLE','2','LAYER',
    '70',String(layerSet.size));
  for(const lname of layerSet){
    L.push('0','LAYER','2',lname,'70','0','62','7','6','CONTINUOUS');
  }
  L.push('0','ENDTAB','0','ENDSEC');

  L.push('0','SECTION','2','ENTITIES');

  if(doc){
    for(const e of (doc.sen||[])){
      const ci=rgbToAci(e.color.r,e.color.g,e.color.b);
      L.push('0','LINE',
        '8',e.layer||'0','62',String(ci),
        '10',String(e.x1),'20',String(e.y1),'30','0',
        '11',String(e.x2),'21',String(e.y2),'31','0');
    }
    for(const e of (doc.enko||[])){
      const ci=rgbToAci(e.color.r,e.color.g,e.color.b);
      const isCircle=(Math.abs(e.a2-e.a1-360)<0.01)||(e.a1===0&&e.a2===360);
      if(isCircle){
        L.push('0','CIRCLE',
          '8',e.layer||'0','62',String(ci),
          '10',String(e.cx),'20',String(e.cy),'30','0',
          '40',String(e.r||e.rx));
      } else {
        L.push('0','ARC',
          '8',e.layer||'0','62',String(ci),
          '10',String(e.cx),'20',String(e.cy),'30','0',
          '40',String(e.r||e.rx),
          '50',String(e.a1),'51',String(e.a2));
      }
    }
    for(const e of (doc.ten||[])){
      const ci=rgbToAci(e.color.r,e.color.g,e.color.b);
      L.push('0','POINT',
        '8',e.layer||'0','62',String(ci),
        '10',String(e.x),'20',String(e.y),'30','0');
    }
    for(const e of (doc.moji||[])){
      const ci=rgbToAci(e.color.r,e.color.g,e.color.b);
      L.push('0','TEXT',
        '8',e.layer||'0','62',String(ci),
        '10',String(e.x),'20',String(e.y),'30','0',
        '40',String(e.h||1),
        '50',String(e.angle||0),
        '1',dxfEncText(e.text||''));
    }
  }

  for(const s of (strokes||[])){
    if(!s.pts||s.pts.length<2) continue;
    const ci=rgbToAci(s.color.r,s.color.g,s.color.b);
    L.push('0','POLYLINE',
      '8','SKETCH','62',String(ci),
      '66','1',
      '10','0','20','0','30','0',
      '70','0');
    for(const p of s.pts){
      L.push('0','VERTEX',
        '8','SKETCH',
        '10',String(p.x),'20',String(p.y),'30','0',
        '70','0');
    }
    L.push('0','SEQEND','8','SKETCH');
  }

  L.push('0','ENDSEC','0','EOF');
  const content=L.join('\n');
  const blob=new Blob([content],{type:'application/octet-stream'});
  const baseName=(currentFileName||'export').replace(/\.[^.]+$/,'');
  const ts=new Date().toISOString().replace(/[:.]/g,'-').slice(0,16);
  const fileName=`${baseName}_export_${ts}.dxf`;
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=fileName;
  document.body.appendChild(a);a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),2000);
  showGuide('DXF書き出し完了',2000);
}

// =========================================================
// V0_141: PDF品質選択定数・ダイアログ
// 安全上限: 500MB（4 canvas × 4 bytes/px × CW × CH）
// V1_147: 「4倍を選んでも3倍と同じデータサイズになる」との指摘を受け見直した。
// 500MBという値はV0_148.2で同時使用Canvasを4枚→最大2枚に削減する前の想定
// （4 canvas×4bytes/px=16bytes/px）のまま据え置かれており、画面解像度の高い
// 機種(iPad Pro等)では2倍の時点で既にこの上限に達してしまい、3倍・4倍のどちらを
// 選んでも実質2倍まで自動格下げされ区別がつかない、という状態になっていた。
// 実態(最大2 canvas=8bytes/px)+エンコード時の一時バッファ分の余裕を見て
// 700MBまで緩和する（下記_PDF_BYTES_PER_PXの見直しと合わせて対応）。
// なお、これでも尚メモリが足りない高解像度機種では引き続き自動格下げが働き、
// 実際のCanvas確保失敗を検知する仕組み(下記のgetImageDataによる実測チェック)も
// 従来通り保護として残っているため、格下げが必要な場面で失敗する懸念はない
// =========================================================
var _PDF_SAFE_MEM_MB = 700;

// V0_154: 品質選択ダイアログ(_pdfQualityDialog)を削除。常に高画質(3倍)で出力する。

// =========================================================
// PDF出力ボタン（V0_141: 高画質オフスクリーンCanvas・品質選択ダイアログ）
// V0_117: PDF専用Canvas作成（pdfCv/pdfOv/pdfAc/pdfComp）
// V0_141: LONG_PX = 画面Canvas長辺 × 選択倍率（2x/3x/4x）
//         メモリ安全: 4x→3x→2x 自動調整（500MB上限）
//         PDF作成後: Canvas width=1 でピクセルバッファ即時解放
// =========================================================
// V1_146: 「PDFの倍率設定を復活させてほしい」との要望を受け、V0_154で廃止していた
// 品質(倍率)選択ダイアログを復活させた。ボタン押下時はまず_showPdfQualityDialogで
// 倍率(2/3/4)を選んでもらい、選択後に実際のPDF生成処理(_runPdfExport、旧ハンドラの
// 中身をそのまま関数化しただけで生成ロジック自体は変更していない)を呼ぶ。
// ダイアログをキャンセルした場合はボタンを再度押せる状態に戻すだけで何もしない
// V1_180: savePDFBtn(設定パネルの「PDF書出」)はHD-PDF書出と機能重複のため削除した。
// _runPdfExport自体は他から参照されなくなるが、念のため関数定義は残す。
// 要素が無くなったためnullガードを追加(旧来は無条件addEventListenerでエラーの元だった)
{var _spdfBtn180=document.getElementById('savePDFBtn');
if(_spdfBtn180){
_spdfBtn180.addEventListener('click', function(){
  const btn = document.getElementById('savePDFBtn');
  if(typeof _showPdfQualityDialog!=='function'){
    // ダイアログ関数が無い場合のフォールバック（従来通り3倍固定で実行）
    btn.disabled = true;
    _runPdfExport(3).finally(function(){ btn.disabled=false; });
    return;
  }
  _showPdfQualityDialog(btn, function(multi){
    btn.disabled = true;
    _runPdfExport(multi).finally(function(){ btn.disabled=false; });
  });
});
}}
async function _runPdfExport(_dlgSel){
  // ── V1_146: 倍率(_dlgSel)は呼び出し元(savePDFBtnハンドラ)がダイアログで選ばせた値を
  // 引数として受け取る。以下の生成ロジック自体はV0_141〜V0_154から変更していない ──
  const _dlgCvEl = document.getElementById('cv');
  const _dlgBaseLong = Math.max(_dlgCvEl.width, _dlgCvEl.height);

  showGuide('PDFを生成中...');

  // V0_141: Canvas解放用参照（outer finally でクリア）
  let _rCv=null, _rOv=null, _rAc=null, _rComp=null, _rHl=null; // V1_170: _rHl追加(蛍光ペン先行描画用)

  try{
    // ── 1. バウンディングボックス計算（V0_111: 全エンティティ対象・hiddenLayer無視）─
    // PDF出力はDXF全体を対象とするため、非表示レイヤも含めてBoundsを計算する
    function _expAll(x,y){if(!isFinite(x)||!isFinite(y))return;if(x<_allMnX)_allMnX=x;if(y<_allMnY)_allMnY=y;if(x>_allMxX)_allMxX=x;if(y>_allMxY)_allMxY=y;}
    var _allMnX=Infinity,_allMnY=Infinity,_allMxX=-Infinity,_allMxY=-Infinity;
    if(doc){
      for(const e of doc.sen){_expAll(e.x1,e.y1);_expAll(e.x2,e.y2);}
      for(const e of doc.enko){const r=e.rx||e.r||0;_expAll(e.cx-r,e.cy-r);_expAll(e.cx+r,e.cy+r);}
      for(const e of doc.ten){_expAll(e.x,e.y);}
      for(const e of doc.moji){_expAll(e.x,e.y);}
      for(const e of doc.solid){for(const p of e.pts)_expAll(p.x,p.y);}
    }
    if(pdfImage){_expAll(pdfImage.wx,pdfImage.wy);_expAll(pdfImage.wx+pdfImage.ww,pdfImage.wy-pdfImage.wh);}
    for(const img of images){_expAll(img.wx,img.wy);_expAll(img.wx+img.ww,img.wy-img.wh);}
    // データなし時はcomputeBBox()にフォールバック
    const _bbFull=isFinite(_allMnX)?{minx:_allMnX,miny:_allMnY,maxx:_allMxX,maxy:_allMxY}:computeBBox();
    let mnX=isFinite(_bbFull.minx)?_bbFull.minx:Infinity;
    let mnY=isFinite(_bbFull.miny)?_bbFull.miny:Infinity;
    let mxX=isFinite(_bbFull.maxx)?_bbFull.maxx:-Infinity;
    let mxY=isFinite(_bbFull.maxy)?_bbFull.maxy:-Infinity;
    function upd(x,y){if(!isFinite(x)||!isFinite(y))return;mnX=Math.min(mnX,x);mxX=Math.max(mxX,x);mnY=Math.min(mnY,y);mxY=Math.max(mxY,y);}
    // ペン・寸法（ユーザー追記）もboundsに含める
    for(const s of strokes)for(const p of s.pts)upd(p.x,p.y);
    for(const d of dims){
      for(const l of(d.lines||[]))upd(l.x1,l.y1),upd(l.x2,l.y2);
      if(d.tx!=null&&d.ty!=null)upd(d.tx,d.ty);
    }
    if(!isFinite(mnX)){showGuide('描画データがありません',2000);return;}

    // ── 2. V0_141: キャンバスサイズ決定（高画質オフスクリーンCanvas）────────
    const PAD=0.02;
    const eW=mxX-mnX, eH=mxY-mnY;
    const extMinX=mnX-eW*PAD, extMinY=mnY-eH*PAD;
    const extW=eW*(1+2*PAD), extH=eH*(1+2*PAD);
    const aspect=extW/extH;

    const PDF_LONG_MM=297;
    const pageMM_W=aspect>=1?PDF_LONG_MM:Math.round(PDF_LONG_MM*aspect);
    const pageMM_H=aspect>=1?Math.round(PDF_LONG_MM/aspect):PDF_LONG_MM;

    // V0_141: メモリ安全チェック（4x→3x→2x 自動調整）
    // V1_147: 1px当たりの見積りバイト数(旧16)を見直した。この「16」は元々、
    // pdfCv/pdfAc/pdfOv/pdfCompの4枚のCanvas(各RGBA=4バイト/px)を同時に保持していた
    // 頃の実装を前提にした値だったが、V0_148.2で「1枚ずつ描画→合成→即解放」方式に
    // 変更され、同時に存在するCanvasは最大2枚(作業用1枚+合成先pdfComp)に削減された。
    // 実態は8バイト/px(2枚分)まで下がっているにも関わらず見積りだけが16バイト/pxの
    // ままだったため、4倍を選んでも3倍相当まで無駄に自動格下げされやすく、
    // 「4倍と3倍が同じデータサイズになる」との指摘につながった。実態(8バイト/px)に
    // toDataURL/JPEGエンコード時の一時バッファ分の余裕を見て10バイト/pxとし、
    // 過剰に保守的だった判定を緩和する（自機種でのメモリ不足時は引き続き
    // 2x以上での自動格下げ・下記の実測失敗検知(Canvasサイズ制限)で保護される）
    const _PDF_BYTES_PER_PX = 10;
    const _PDF_MAX_MEM_B = _PDF_SAFE_MEM_MB * 1024 * 1024;
    let _safeMulti = _dlgSel;
    while (_safeMulti >= 2) {
      const _lp = Math.round(_dlgBaseLong * _safeMulti);
      const _cW = aspect >= 1 ? _lp : Math.round(_lp * aspect);
      const _cH = aspect >= 1 ? Math.round(_lp / aspect) : _lp;
      if (_cW * _cH * _PDF_BYTES_PER_PX <= _PDF_MAX_MEM_B) break;
      _safeMulti--;
    }
    if (_safeMulti < 2) { showGuide('メモリ不足のため出力できません',3000); return; }
    if (_safeMulti !== _dlgSel) {
      console.warn('[PDF V0_141] メモリ制限: '+_dlgSel+'x → '+_safeMulti+'x に自動調整');
      showGuide(_dlgSel+'x → '+_safeMulti+'x に自動調整中...',1500);
      await new Promise(r=>setTimeout(r,800));
    }

    // ── 3. 状態退避・PDF用設定 ─────────────────────────────────────
    const sv={tx,ty,scale};
    const cvEl=document.getElementById('cv');
    const ovEl=document.getElementById('ov');
    const sv_ow=ovEl.width;  // _pdfScale計算用
    const dprSave=window.devicePixelRatio||1;

    // V0_141: LONG_PX = 画面Canvas長辺 × 選択倍率
    let LONG_PX = Math.round(_dlgBaseLong * _safeMulti);
    let CW = aspect>=1 ? LONG_PX : Math.round(LONG_PX*aspect);
    let CH = aspect>=1 ? Math.round(LONG_PX/aspect) : LONG_PX;
    let pdfScale = Math.min(CW/extW, CH/extH);
    tx=-extMinX*pdfScale; ty=CH+extMinY*pdfScale; scale=pdfScale;

    // V0_117: ④ Canvasサイズ制限の検知 / ⑤ 制限超過時はLONG_PX縮小で対応
    {
      const _tc=document.createElement('canvas');
      _tc.width=CW; _tc.height=CH;
      const _tc2=_tc.getContext('2d');
      _tc2.fillStyle='#f00'; _tc2.fillRect(CW-1,CH-1,1,1);
      if(_tc2.getImageData(CW-1,CH-1,1,1).data[3]===0){
        // Canvas制限超過。LONG_PXを0.75倍ずつ縮小して再探索
        let _lpx=Math.floor(LONG_PX*0.75);
        let _found=false;
        while(_lpx>=2000){
          const _tCW=aspect>=1?_lpx:Math.round(_lpx*aspect);
          const _tCH=aspect>=1?Math.round(_lpx/aspect):_lpx;
          const _tc3=document.createElement('canvas'); _tc3.width=_tCW; _tc3.height=_tCH;
          const _tc4=_tc3.getContext('2d');
          _tc4.fillStyle='#f00'; _tc4.fillRect(_tCW-1,_tCH-1,1,1);
          if(_tc4.getImageData(_tCW-1,_tCH-1,1,1).data[3]>0){CW=_tCW;CH=_tCH;_found=true;break;}
          _lpx=Math.floor(_lpx*0.75);
        }
        if(!_found){showGuide('Canvasサイズが不足しています',3000);return;}
        pdfScale=Math.min(CW/extW,CH/extH);
        tx=-extMinX*pdfScale; ty=CH+extMinY*pdfScale; scale=pdfScale;
        console.warn('[PDF V0_141] Canvasサイズ制限 → '+CW+'×'+CH+'px に縮小');
      }
    }

    // draw()内部のctx.scale(dpr,dpr)をdpr=1に固定してcanvas=CW×CHで正確に描画させる
    Object.defineProperty(window,'devicePixelRatio',{get:()=>1,configurable:true});
    // PDF用線幅スケール: CW/CSS_W（CSS幅比率）
    window._pdfScale=CW*dprSave/sv_ow;

    // 描画グローバル（cv/ctx/ov/octx）退避（finally で必ず復元）
    const _svCv=window.cv,_svCtx=window.ctx,_svOv=window.ov,_svOctx=window.octx;

    // V0_148.2: PDF専用Canvasを3枚同時に持たず「描画→合成→即解放」を1枚ずつ行う方式に変更。
    // 【背景】従来はpdfCv+pdfAc+pdfOv+pdfComp の計4枚(各CW×CH)を同時に保持していたため、
    // 高画質(3x/4x)選択時にiPadでメモリが逼迫し、Canvasへの描画が一部しか反映されない
    // （PDF範囲が部分的になる）不具合が発生していた。アプリ起動直後などメモリに余裕がない
    // タイミングで再現しやすく、キャンセルして再試行すると正常になる、という報告と一致する。
    // 1枚ずつ生成→drawImageで合成先へ焼き込み→即座にwidth=1で解放することで、
    // 同時に存在する大きなCanvasを最大2枚（作業用1枚+合成先pdfComp）まで削減する。
    // draw()はcv/ctxのみ、drawOverlay()はov/octxのみ、drawAnnotation()は引数ctxのみで
    // 完結しており、3者は互いに独立して呼び出せることを確認済み（既存の描画ロジックは無変更）。
    let pdfComp=null;
    try{
      pdfComp=document.createElement('canvas'); pdfComp.width=CW; pdfComp.height=CH;
      _rComp=pdfComp;
      const pctx=pdfComp.getContext('2d');
      pctx.fillStyle=bwMode?'#fff':'#1e2430';
      pctx.fillRect(0,0,CW,CH);

      // ①' 蛍光ペンのみ先行描画（V1_170: DXF/文字より下に敷くことで、印刷時に黒文字が
      // 蛍光の半透明色で薄く見えてしまう問題を解消。実際の蛍光ペンのように「先に引いた
      // 上へ黒字が重なる」順序にする。drawAnnotation()の第2引数'hl'で蛍光のみ描画）
      {
        const pdfHl=document.createElement('canvas'); pdfHl.width=CW; pdfHl.height=CH;
        const pdfHlCtx=pdfHl.getContext('2d');
        _rHl=pdfHl;
        if(typeof drawAnnotation==='function') drawAnnotation(pdfHlCtx,'hl');
        pctx.drawImage(pdfHl,0,0);
        pdfHl.width=1; pdfHl.height=1; _rHl=null; // 即解放
      }

      // ① メインDXF図形（draw: cv/ctxのみ使用）
      {
        const pdfCv=document.createElement('canvas'); pdfCv.width=CW; pdfCv.height=CH;
        const pdfCtx=pdfCv.getContext('2d');
        _rCv=pdfCv;
        window.cv=pdfCv; window.ctx=pdfCtx;
        if(typeof draw==='function') draw();
        pctx.drawImage(pdfCv,0,0);
        pdfCv.width=1; pdfCv.height=1; _rCv=null; // 即解放
      }

      // ② ペン書き込み（drawAnnotation: 第2引数'pen'で蛍光を除外し、文字の上に重ねる
      // 従来通りの見た目を維持する。蛍光ペンは①'で描画済みのためここでは対象外）
      {
        const pdfAc=document.createElement('canvas'); pdfAc.width=CW; pdfAc.height=CH;
        const pdfAcCtx=pdfAc.getContext('2d');
        _rAc=pdfAc;
        if(typeof drawAnnotation==='function') drawAnnotation(pdfAcCtx,'pen');
        pctx.drawImage(pdfAc,0,0);
        pdfAc.width=1; pdfAc.height=1; _rAc=null; // 即解放
      }

      // ③ 寸法（drawOverlay: ov/octxのみ使用）
      {
        const pdfOv=document.createElement('canvas'); pdfOv.width=CW; pdfOv.height=CH;
        const pdfOctx=pdfOv.getContext('2d');
        _rOv=pdfOv;
        window.ov=pdfOv; window.octx=pdfOctx;
        if(typeof drawOverlay==='function') drawOverlay();
        pctx.drawImage(pdfOv,0,0);
        pdfOv.width=1; pdfOv.height=1; _rOv=null; // 即解放
      }

      // 描画完了を待つ（V0_141由来の安全待機）
      await new Promise(r=>requestAnimationFrame(r));
    }finally{
      // 描画エラー時も必ず状態を復元（表示用Canvasへの影響ゼロ）
      try{Object.defineProperty(window,'devicePixelRatio',{get:()=>dprSave,configurable:true});}catch(e){}
      window._pdfScale=undefined;
      window.cv=_svCv; window.ctx=_svCtx; window.ov=_svOv; window.octx=_svOctx;
      tx=sv.tx; ty=sv.ty; scale=sv.scale;
      if(typeof scheduleDraw==='function') scheduleDraw();
      if(typeof scheduleOverlay==='function') scheduleOverlay();
    }
    if(!pdfComp){showGuide('描画に失敗しました',2000);return;}

    // ── 5. jsPDF で PDF 生成（JPEG 0.97: 高品質・大容量PNG回避）──────────
    if(typeof window.jspdf==='undefined'){
      const url=URL.createObjectURL(await new Promise(r=>pdfComp.toBlob(r,'image/png')));
      const a=document.createElement('a');
      a.href=url; a.download=(currentFileName||'drawing').replace(/\.[^.]+$/,'')+`_${new Date().toISOString().slice(0,10)}.png`;
      document.body.appendChild(a);a.click();document.body.removeChild(a);
      setTimeout(()=>URL.revokeObjectURL(url),2000);
      showGuide('画像として保存しました',2000); return;
    }
    const {jsPDF}=window.jspdf;
    const orient=pageMM_W>=pageMM_H?'l':'p';
    const pdf=new jsPDF({orientation:orient,unit:'mm',format:[pageMM_W,pageMM_H],compress:true});
    const imgData=pdfComp.toDataURL('image/jpeg',0.97);
    pdf.addImage(imgData,'JPEG',0,0,pageMM_W,pageMM_H);
    const fname=(currentFileName||'drawing').replace(/\.[^.]+$/,'')+'.pdf'; // V0_96: DXFファイル名をそのまま使用
    pdf.save(fname);
    // V1_147: 「4倍を選んだのに3倍と同じサイズになった」との指摘は、生成途中の
    // 自動調整メッセージ(1.5秒のみ表示)を見逃すと、保存完了メッセージだけでは
    // 実際に使われた倍率が選んだ倍率と違うことに気づけないのが原因だった。
    // 自動調整が起きた場合は保存完了メッセージ自体にも選択値→実際値を明記し、
    // 見逃しにくいよう表示時間も長くする
    var _multiNote147=(_safeMulti!==_dlgSel)?(_dlgSel+'x→'+_safeMulti+'xに自動調整・'):'';
    showGuide('PDFを保存しました（'+_multiNote147+_safeMulti+'x / '+CW+'×'+CH+'px）',_multiNote147?4000:2500);
    if(typeof window._afterPDFExport==='function'){var _cb=window._afterPDFExport;window._afterPDFExport=null;setTimeout(_cb,600);}

  }catch(err){
    console.error('PDF export error:',err);
    showGuide('PDF出力に失敗しました: '+err.message,3000);
  }finally{
    // V0_141: Canvas解放（ピクセルバッファを即時返却して GC を促進）
    try{
      if(_rCv)  { _rCv.width=1;   _rCv.height=1;   } _rCv=null;
      if(_rOv)  { _rOv.width=1;   _rOv.height=1;   } _rOv=null;
      if(_rAc)  { _rAc.width=1;   _rAc.height=1;   } _rAc=null;
      if(_rHl)  { _rHl.width=1;   _rHl.height=1;   } _rHl=null; // V1_170
      if(_rComp){ _rComp.width=1; _rComp.height=1; } _rComp=null;
    }catch(e){}
    // V1_146: btn.disabled=falseは呼び出し元(savePDFBtnハンドラ)の.finally()側で
    // 行うよう変更した（この関数はボタン要素を引数に持たない独立関数のため）
  }
}

// =========================================================
// V0_147: スクリーンショット機能削除（screenshotBtnハンドラ・html2canvas依存を廃止）
// =========================================================

// =========================================================
// DXF書き出しボタン
// =========================================================
// V0_154: 「DXF書き込み書出し」ボタンを削除（exportDxfBtn要素なし。exportSketchDxf関数自体は未使用のまま保持）

// =========================================================
// V0_122: .dxfview書出し（dims + strokes のみ）
// =========================================================
// V0_127: .dxfview自動保存対応。IDB(自動保存)→メモリの頪で読み込み、ダウンロード
async function exportDxfview(){
  try{
    const fk=(_fileKey?_fileKey(currentFileName,currentFileSize):null)||currentFileName||'';
    // IDBから自動保存データを読み込む
    let payload=await new Promise(function(resolve){
      try{
        var r=indexedDB.open('dxfViewerDxfviewDB',1);
        r.onupgradeneeded=function(e){e.target.result.createObjectStore('dv',{keyPath:'fk'});};
        r.onsuccess=function(e){
          try{
            var tx=e.target.result.transaction('dv','readonly');
            var gr=tx.objectStore('dv').get(fk);
            gr.onsuccess=function(){resolve(gr.result||null);};
            gr.onerror=function(){resolve(null);};
          }catch(er){resolve(null);}
        };
        r.onerror=function(){resolve(null);};
      }catch(e){resolve(null);}
    });
    // IDBになければメモリから取得
    if(!payload){
      if((!dims||dims.length===0)&&(!strokes||strokes.length===0)){
        showGuide('保存するデータがありません',2000);return;
      }
      payload={format:'dxfview',version:1,
        fileName:currentFileName||'',fileSize:currentFileSize||0,
        fileKey:fk,dims:dims,strokes:strokes};
    }
    payload.appVersion=APP_VERSION;
    payload.exportedAt=new Date().toISOString();
    const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});
    const base=(currentFileName||'export').replace(/\.[^.]+$/,'');
    const date=new Date().toISOString().slice(0,10);
    const fname=base+'_'+date+'.dxfview';
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=fname;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),2000);
    showGuide('.dxfviewを保存しました',2000);
  }catch(e){
    console.warn('[dxfview export] failed',e);
    showGuide('.dxfview保存に失敗しました',2000);
  }
}
// V0_136: exportDxfviewBtnは削除（書込バックアップ/書込復元に置き換え）

// =========================================================
// V0_136: 書込バックアップ（ヘッダーボタン）
// strokes / dims / savedViews / hiddenLayers を .dxfview に保存
// =========================================================
// =========================================================
// V0_141.1: 書込バックアップ保存先フォルダ記憶
// File System Access API (showSaveFilePicker) が利用可能な環境では
// 前回のFileHandleをIDBに保存し、次回保存時のstartInに利用する。
// FileHandleをstartInに渡すと「そのファイルがあるフォルダ」で開く。
// API非対応環境（iPad Safari等）は従来の<a>ダウンロードへ自動フォールバック。
// =========================================================
var _BKDIR_IDB = 'dxfViewerSettingsDB'; // 既存DBとは分離した設定専用DB
var _BKDIR_KEY = 'backupFileHandle';     // IDB内キー（FileSystemFileHandle）

// 前回の保存FileHandleをIDBから非同期読み込み
function _bkHandleLoad() {
  return new Promise(function(resolve) {
    try {
      var r = indexedDB.open(_BKDIR_IDB, 1);
      r.onupgradeneeded = function(e) { e.target.result.createObjectStore('s'); };
      r.onsuccess = function(e) {
        try {
          var tx = e.target.result.transaction('s', 'readonly');
          var req = tx.objectStore('s').get(_BKDIR_KEY);
          req.onsuccess = function() { resolve(req.result || null); };
          req.onerror   = function() { resolve(null); };
        } catch(er) { resolve(null); }
      };
      r.onerror = function() { resolve(null); };
    } catch(e) { resolve(null); }
  });
}

// 今回の保存FileHandleをIDBに非同期書き込み（fire-and-forget）
function _bkHandleSave(handle) {
  try {
    var r = indexedDB.open(_BKDIR_IDB, 1);
    r.onupgradeneeded = function(e) { e.target.result.createObjectStore('s'); };
    r.onsuccess = function(e) {
      try {
        var tx = e.target.result.transaction('s', 'readwrite');
        tx.objectStore('s').put(handle, _BKDIR_KEY);
      } catch(er) { console.warn('[bkDir] IDB write failed', er); }
    };
  } catch(e) { console.warn('[bkDir] IDB open failed', e); }
}

// =========================================================
// V0_136: 書込バックアップ（ヘッダーボタン）
// strokes / dims / savedViews / hiddenLayers を .dxfview に保存
// V0_141.1: File System Access API 対応（保存先フォルダ記憶）
// V1_176: .dxfviewと元DXFの生データを1つのZIPにまとめて保存する方式に変更
// =========================================================
// V1_183: exportDxfviewManualからペイロード(JSON文字列)・同梱DXF情報の構築部分だけを
// 切り出した共通処理。保存(showSaveFilePicker等)は行わない。データが無ければnullを返す。
// 複数ファイル一括バックアップ(exportDxfviewManualBatch183)からも使う
function _buildDxfviewBackupPayload183(){
  if((!dims||dims.length===0)&&(!strokes||strokes.length===0)&&
     (!savedViews||savedViews.every(function(v){return!v;}))&&
     (!hiddenLayers||hiddenLayers.size===0)){
    return null;
  }
  const fk=(typeof _fileKey==='function'?_fileKey(currentFileName,currentFileSize):null)||currentFileName||'';
  const payload={
    version:1,
    format:'dxfview-backup',
    createdAt:new Date().toISOString(),
    appVersion:(typeof APP_VERSION!=='undefined'?APP_VERSION:''),
    meta:{
      fileName:currentFileName||'',
      fileSize:currentFileSize||0,
      fileKey:fk
    },
    strokes:(typeof strokes!=='undefined'?strokes:[]),
    dims:(typeof dims!=='undefined'?dims:[]),
    savedViews:(typeof savedViews!=='undefined'?savedViews:[null,null,null,null,null]),
    hiddenLayers:(typeof hiddenLayers!=='undefined'?[...hiddenLayers]:[])
  };
  const base=(currentFileName||'').replace(/\.[^.]+$/,'')||null;
  const dxfviewName=(base?base+'_書込み':'書込み')+'.dxfview';
  // openFilesBufs[]には開いている各タブの元ファイルの生バイナリがキャッシュされている
  // (index.html fileInput.change等で設定)。取得できた場合のみ元DXFも同梱する
  const origBuf=(typeof openFilesBufs!=='undefined'&&typeof currentFileIdx!=='undefined'&&currentFileIdx>=0)?openFilesBufs[currentFileIdx]:null;
  return {
    payloadJson: JSON.stringify(payload),
    dxfviewName: dxfviewName,
    drawName: currentFileName||null,
    drawBuf: (origBuf&&currentFileName)?origBuf:null,
    base: base
  };
}
async function exportDxfviewManual(){
  try{
    // ── ペイロード作成（V1_183: _buildDxfviewBackupPayload183に切り出し。ロジック自体は無変更）───
    var _entry183=_buildDxfviewBackupPayload183();
    if(!_entry183){
      showGuide('保存するデータがありません',2000);return true; // V0_145: データなし=バックアップ不要なので閉じる処理は継続
    }
    const dxfviewName=_entry183.dxfviewName;
    const base=_entry183.base;

    // V1_176: 「.dxfviewと元のDXFを同じフォルダに残すと、どちらがどのファイルの
    // バックアップか分かりにくい／片方だけ移動して対応が取れなくなる」との指摘により、
    // .dxfview単体ではなく、元DXFの生データと.dxfviewを1つのZIPにまとめて保存する方式に変更した。
    if(typeof JSZip==='undefined'){
      showGuide('ZIP機能が読み込まれていません',2000);
      return false;
    }
    const zip=new JSZip();
    zip.file(dxfviewName, _entry183.payloadJson);
    var _dxfIncluded176=false;
    if(_entry183.drawBuf && _entry183.drawName){
      zip.file(_entry183.drawName, _entry183.drawBuf);
      _dxfIncluded176=true;
    }
    const blob=await zip.generateAsync({type:'blob'});
    const fname=(base?base+'_書込みバックアップ':'書込みバックアップ')+'.zip';

    // ── V0_141.1: File System Access API でフォルダ記憶保存 ────────
    var _fsaSaved = false;
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        // 前回のFileHandleをIDBから取得（startInに渡すと前回フォルダで開く）
        var _prevHandle = await _bkHandleLoad();
        var opts = {
          suggestedName: fname,
          types: [{ description: 'DXF+書込みバックアップ(ZIP)', accept: { 'application/zip': ['.zip'] } }] // V1_176: ZIP化に合わせて一致させる
        };
        if (_prevHandle) {
          // 前回ハンドルをstartInに指定（無効な場合はブラウザが自動的にデフォルトへ）
          try { opts.startIn = _prevHandle; } catch(e) {}
        }
        var fh = await window.showSaveFilePicker(opts);
        var writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
        _bkHandleSave(fh); // 今回のFileHandleを記憶（次回のstartIn用）
        _fsaSaved = true;
      } catch(e) {
        if (e && e.name === 'AbortError') return false; // ユーザーキャンセル → 静かに終了（V0_145: 閉じる連携用にfalseを返す）
        // APIエラー（権限・非対応等）→ 従来方式でフォールバック
        console.warn('[backup] showSaveFilePicker failed, fallback to <a>:', e);
      }
    }

    // ── V0_146: PWA（ホーム画面起動）時は Web Share API で共有シートを直接表示 ──
    // PWAでは<a download>が使えず、iOSのプレビュー画面→「その他...」→フォルダ選択という
    // 遠回りな動線になり、ファイル名にも勝手に「.json」が付く。
    // navigator.share(File) ならプレビューを飛ばして共有シート（ファイルに保存）へ直行し、
    // .dxfviewのファイル名もそのまま保持される。
    // 通常のSafari起動時は従来の<a>ダウンロードのまま（ダウンロード先設定で1タップ保存が最速のため）。
    //
    // 【V1_13〜V1_17での検討経緯・最終方針】
    // 実機検証の結果、以下3方式はいずれも一長一短でトレードオフの関係にあり、
    // 「タップ無し・共有シートの選択肢が豊富・余分なファイルも出ない」を同時に
    // 満たす方法はiOSの仕様上存在しないことを確認した：
    //   (a) Web Share + textなし(V1_13): タップ無し／選択肢少ない(コピー・Dropbox等が
    //       出ない)／余分ファイル無し
    //   (b) Web Share + text指定(V1_14): タップ無し／選択肢豊富／余分な「ファイル
    //       <日時>.txt」が毎回もう1つ保存される
    //   (c) <a>ダウンロードに統一(V1_15/V1_16): 保存前にiOS標準のプレビュー画面
    //       →「その他...」を押す一手間が必要／選択肢豊富／余分ファイル無し
    // ユーザーと相談の上、「保存の一手間が無いこと」を最優先し、(b)のWeb Share+text
    // 方式を最終採用とした（余分なテキストファイルが毎回1つ増える点は、ユーザーが
    // 把握・許容の上で受け入れ済み）。
    if (!_fsaSaved) {
      var _isStandalone = (window.navigator.standalone === true) ||
                          (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
      if (_isStandalone && navigator.share && typeof navigator.canShare === 'function') {
        try {
          var shareFile = new File([blob], fname, { type: 'application/zip' }); // V1_176: ZIP化に合わせて変更
          if (navigator.canShare({ files: [shareFile] })) {
            // V1_17: text指定のWeb Share方式（上記経緯により最終採用）。
            // 余分なテキストファイルが毎回もう1つ保存されるのは既知・許容済みの
            // 仕様上の制約であり、不具合ではない
            await navigator.share({ files: [shareFile], text: fname });
            _fsaSaved = true; // 共有完了扱い
          }
        } catch (e) {
          if (e && e.name === 'AbortError') return false; // 共有シートでキャンセル → 閉じ処理も中断
          console.warn('[backup] navigator.share failed, fallback to <a>:', e);
        }
      }
    }

    // ── フォールバック: 従来の <a> ダウンロード（Safari等）────
    if (!_fsaSaved) {
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;a.download=fname;
      document.body.appendChild(a);a.click();document.body.removeChild(a);
      setTimeout(function(){URL.revokeObjectURL(url);},2000);
    }

    if(typeof verify==='function')verify('バックアップ保存',{strokes:typeof strokes!=='undefined'?strokes.length:-1,dims:typeof dims!=='undefined'?dims.length:-1,dxfIncluded:_dxfIncluded176});
    _abMarkSaved(); // V0_141.2: バックアップ成功時に自動バックアップ促進タイマーをリセット
    // V1_176: 元DXFを同梱できなかった場合はその旨を伝える(書込みデータ自体は保存済み)
    showGuide(_dxfIncluded176?'DXFと書込みデータをZIPに保存しました':'書込みデータのみZIPに保存しました(元DXFは同梱できませんでした)',2500);
    return true; // V0_145: 保存成功（閉じる連携用）
  }catch(e){
    console.warn('[dxfview backup] failed',e);
    showGuide('バックアップ保存に失敗しました',2000);
    return false; // V0_145: 保存失敗時は閉じない（データ消失防止）
  }
}
// V2_30: ヘッダー「バックアップ」ボタン(writeBackupBtn)は廃止。
// V2_34: 「現在開いている1ファイルだけ」を対象にしたバックアップとして、
// 新しいid「fileBackupBtn234」(ラベル:ファイルBackup)で復活させる
{var _fileBackupBtn234=document.getElementById('fileBackupBtn234');
if(_fileBackupBtn234) _fileBackupBtn234.addEventListener('click',exportDxfviewManual);}

// =========================================================
// V1_183: 複数ファイル一括書出(HD-PDF書出/バックアップ)用の共通保存処理。
// exportDxfviewManual内の保存処理(showSaveFilePicker→Web Share→<a>download の
// 3段フォールバック)と同じロジックを、任意のBlob/ファイル名向けに汎用化したもの。
//
// 【なぜ複数ファイルをまとめて1回だけ保存するのか】
// 「開いているファイル一覧」で複数選択してHD-PDF書出/バックアップを実行すると、
// 1件目は保存されるが2件目以降が保存されない(何も起きない)という不具合が報告された。
// 原因は、showSaveFilePicker/navigator.share/<a>ダウンロードのいずれも
// 「1回のユーザー操作(タップ)につき1回」しかブラウザ側が保存・共有を許可しない
// ことにある(特にiOS Safariで顕著)。複数ファイルをループで1件ずつ
// switchToFile→exportHybridPDF/exportDxfviewManualのように毎回保存処理まで
// 実行すると、2回目以降のshowSaveFilePicker/share呼び出しがブラウザに拒否され、
// <a>ダウンロードへのフォールバックも同様にブロックされてしまっていた。
// 対策として、各ファイルの生成物(PDFのBlob、またはバックアップ用ZIPの中身)は
// 個別に保存せずいったん集めておき、全ファイル処理後にそれらを1つのZIPへ
// まとめて、保存処理(このファイル関数)を「ボタン操作1回につき1回」だけ呼ぶ
// ようにした。
// =========================================================
async function _saveBlobWithFallback183(blob, fname, typeDesc){
  var _fsaSaved=false;
  if(typeof window.showSaveFilePicker==='function'){
    try{
      var _prevHandle=await _bkHandleLoad();
      var opts={suggestedName:fname, types:[{description:typeDesc||'ZIP', accept:{'application/zip':['.zip']}}]};
      if(_prevHandle){ try{opts.startIn=_prevHandle;}catch(e){} }
      var fh=await window.showSaveFilePicker(opts);
      var writable=await fh.createWritable();
      await writable.write(blob);
      await writable.close();
      _bkHandleSave(fh);
      _fsaSaved=true;
    }catch(e){
      if(e&&e.name==='AbortError') return false;
      console.warn('[batch save] showSaveFilePicker failed, fallback:',e);
    }
  }
  if(!_fsaSaved){
    var _isStandalone=(window.navigator.standalone===true)||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);
    if(_isStandalone&&navigator.share&&typeof navigator.canShare==='function'){
      try{
        var shareFile=new File([blob],fname,{type:'application/zip'});
        if(navigator.canShare({files:[shareFile]})){
          await navigator.share({files:[shareFile],text:fname});
          _fsaSaved=true;
        }
      }catch(e){
        if(e&&e.name==='AbortError') return false;
        console.warn('[batch save] navigator.share failed, fallback:',e);
      }
    }
  }
  if(!_fsaSaved){
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');
    a.href=url;a.download=fname;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(function(){URL.revokeObjectURL(url);},2000);
  }
  return true;
}

// V1_183: 複数ファイル一括「HD-PDF書出」。各ファイルのHD-PDFは個別保存せずBlobとして
// 集め、最後に1つのZIPにまとめて1回だけ保存する(理由は_saveBlobWithFallback183参照)
async function exportHybridPDFBatch183(indices){
  var collected=[];
  var skipped=0;
  for(var i=0;i<indices.length;i++){
    var idx=indices[i];
    var f=openFiles[idx];
    var fname183=(f&&(f.currentFileName||f.name))||'';
    if(typeof showGuide==='function') showGuide('HD-PDF生成中 ('+(i+1)+'/'+indices.length+') '+fname183,2000);
    if(idx!==currentFileIdx&&typeof switchToFile==='function') switchToFile(idx);
    try{
      var before=collected.length;
      var ok=await exportHybridPDF(collected);
      if(ok===false||collected.length===before) skipped++;
    }catch(e){ console.warn('[batch HD-PDF]',e); skipped++; }
  }
  if(collected.length===0){
    if(typeof showGuide==='function') showGuide('HD-PDFを生成できるデータがありませんでした',2500);
    return {count:0,skipped:skipped};
  }
  if(typeof JSZip==='undefined'){
    if(typeof showGuide==='function') showGuide('ZIP機能が読み込まれていません',2000);
    return {count:0,skipped:indices.length};
  }
  var zip183=new JSZip();
  var usedNames183={};
  collected.forEach(function(item){
    var name=item.fname;
    if(usedNames183[name]){ usedNames183[name]++; name=name.replace(/\.pdf$/i,'')+'_'+usedNames183[name]+'.pdf'; }
    else usedNames183[name]=1;
    zip183.file(name, item.blob);
  });
  var blob183=await zip183.generateAsync({type:'blob'});
  var dateStr183=new Date().toISOString().slice(0,10).replace(/-/g,'');
  var zipFname183='HD-PDF書出_'+collected.length+'件_'+dateStr183+'.zip';
  await _saveBlobWithFallback183(blob183, zipFname183, 'HD-PDF書出(ZIP)');
  return {count:collected.length, skipped:skipped};
}

// V1_183: 複数ファイル一括「バックアップ」。各ファイルの書込みバックアップを
// ファイルごとのサブフォルダに分けて1つの親ZIPにまとめ、1回だけ保存する
// (理由は_saveBlobWithFallback183参照)
async function exportDxfviewManualBatch183(indices){
  if(typeof JSZip==='undefined'){
    if(typeof showGuide==='function') showGuide('ZIP機能が読み込まれていません',2000);
    return {count:0,skipped:indices.length};
  }
  var zip183=new JSZip();
  var included=0, skipped=0;
  var usedFolders183={};
  for(var i=0;i<indices.length;i++){
    var idx=indices[i];
    var f=openFiles[idx];
    var fname183=(f&&(f.currentFileName||f.name))||'';
    if(typeof showGuide==='function') showGuide('バックアップ準備中 ('+(i+1)+'/'+indices.length+') '+fname183,2000);
    if(idx!==currentFileIdx&&typeof switchToFile==='function') switchToFile(idx);
    var entry=_buildDxfviewBackupPayload183();
    if(!entry){ skipped++; continue; }
    var folderBase183=entry.base||fname183.replace(/\.[^.]+$/,'')||('file'+idx);
    var folderName183=folderBase183;
    var n183=usedFolders183[folderBase183];
    if(n183){ usedFolders183[folderBase183]=n183+1; folderName183=folderBase183+'_'+(n183+1); }
    else usedFolders183[folderBase183]=1;
    var folder183=zip183.folder(folderName183);
    folder183.file(entry.dxfviewName, entry.payloadJson);
    if(entry.drawBuf&&entry.drawName) folder183.file(entry.drawName, entry.drawBuf);
    included++;
  }
  if(included===0){
    if(typeof showGuide==='function') showGuide('バックアップするデータがありませんでした',2500);
    return {count:0,skipped:skipped};
  }
  var blob183=await zip183.generateAsync({type:'blob'});
  var dateStr183b=new Date().toISOString().slice(0,10).replace(/-/g,'');
  var zipFname183=(included+'件_書込みバックアップ_'+dateStr183b)+'.zip';
  await _saveBlobWithFallback183(blob183, zipFname183, 'まとめてバックアップ(ZIP)');
  if(typeof _abMarkSaved==='function') _abMarkSaved();
  return {count:included, skipped:skipped};
}

// =========================================================
// V2_23: 全書込みデータ一括バックアップ(設定パネル)
// dxfViewerDxfviewDB(dv)に保存されている全レコード(タブを閉じて既にopenFilesに
// 存在しないファイルの分も含む)をまとめて1つのZIPに書き出す。既存のヘッダー
// 「バックアップ」ボタン/複数選択一括バックアップ(exportDxfviewManualBatch183)は
// いずれも「現在タブとして開いているファイル」のみが対象で、既に閉じてしまった
// ファイルの書込みまでは保護できなかったための追加。
// dvストアはreadonlyでgetAll()するだけで、既存の保存・復元処理には一切触れない。
// 元DXF/PDF本体は含めない(容量が大きくなりすぎるため。本体はiPad「ファイル」App側に
// 別途あるので、書込み履歴だけ保護すれば十分という前提)。
// =========================================================
async function exportAllDvBackup223(){
  try{
    if(typeof JSZip==='undefined'){
      if(typeof showGuide==='function') showGuide('ZIP機能が読み込まれていません',2000);
      return;
    }
    var recs=await new Promise(function(resolve){
      try{
        var r=indexedDB.open('dxfViewerDxfviewDB',1);
        r.onupgradeneeded=function(e){ if(!e.target.result.objectStoreNames.contains('dv')) e.target.result.createObjectStore('dv',{keyPath:'fk'}); };
        r.onsuccess=function(e){
          try{
            var db=e.target.result;
            if(!db.objectStoreNames.contains('dv')){ resolve([]); return; }
            var tx=db.transaction('dv','readonly');
            var gr=tx.objectStore('dv').getAll();
            gr.onsuccess=function(){resolve(gr.result||[]);};
            gr.onerror=function(){resolve([]);};
          }catch(er){resolve([]);}
        };
        r.onerror=function(){resolve([]);};
      }catch(e){resolve([]);}
    });
    if(!recs||recs.length===0){
      if(typeof showGuide==='function') showGuide('保存されている書込みデータがありません',2000);
      return;
    }
    var zip223=new JSZip();
    var usedNames223={};
    recs.forEach(function(rec){
      var base223=String(rec.fileName||rec.fk||'file').replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|]/g,'_');
      // V2_25: 「ファイル名_サイズ(KB整数)」形式に変更(例:1C-03(X4Y1)_915.dxfview)。
      // fileSizeはバイト単位で保存されているため1024で割って整数に丸める
      var sizeKB225=Math.round((rec.fileSize||0)/1024);
      var baseWithSize225=base223+'_'+sizeKB225;
      var name223=baseWithSize225+'.dxfview';
      var n223=usedNames223[baseWithSize225];
      if(n223){ usedNames223[baseWithSize225]=n223+1; name223=baseWithSize225+'_'+(n223+1)+'.dxfview'; }
      else usedNames223[baseWithSize225]=1;
      var payload223=Object.assign({},rec,{appVersion:(typeof APP_VERSION!=='undefined'?APP_VERSION:''),exportedAt:new Date().toISOString()});
      zip223.file(name223, JSON.stringify(payload223));
    });
    if(typeof showGuide==='function') showGuide('ZIP作成中…('+recs.length+'件)',2000);
    var blob223=await zip223.generateAsync({type:'blob'});
    // V2_25: ZIPファイル名を「YYMMDD_全書込みデータ_N件」形式に変更(例:260904_全書込みデータ_283件)。
    // 西暦は下2桁から始める
    var d225=new Date();
    var dateStr223=String(d225.getFullYear()).slice(-2)+String(d225.getMonth()+1).padStart(2,'0')+String(d225.getDate()).padStart(2,'0');
    var fname223=dateStr223+'_全書込みデータ_'+recs.length+'件.zip';
    await _saveBlobWithFallback183(blob223, fname223, '全書込みデータ(ZIP)');
    if(typeof showGuide==='function') showGuide('全書込みデータをZIPに保存しました('+recs.length+'件)',2500);
  }catch(e){
    console.warn('[all dv backup] failed',e);
    if(typeof showGuide==='function') showGuide('一括バックアップに失敗しました',2000);
  }
}
{var _allDvBtn223=document.getElementById('allDvBackupBtn');
if(_allDvBtn223) _allDvBtn223.addEventListener('click',exportAllDvBackup223);}

// =========================================================
// V2_24: 開いていないファイルの本体データ一括削除(設定パネル)
// dxfViewerFilesDB(dxfFiles)に保存されているファイル本体のうち、現在どのタブにも
// 開かれていない(openFilesに存在しない)ものだけをまとめて削除する。
// V2_24以降、タブを閉じた時点で該当ファイルの本体は自動的に削除されるように
// なった(index.htmlのdoCloseTab参照)ため、このボタンは主にV2_23以前から
// 溜まっている過去分をまとめて整理するためのもの。
// 書込み履歴(dv)・自動バックアップ(backups)・検索インデックスには一切触れない
// (本体のみ削除。同じファイルをもう一度開けば書込み履歴は自動的に復元される)。
// 削除前に対象件数・合計容量を表示し、確認を取ってから実行する。
// =========================================================
async function purgeUnopenedFileBodies224(){
  try{
    var scan=await new Promise(function(resolve){
      try{
        var r=indexedDB.open('dxfViewerFilesDB',1);
        r.onupgradeneeded=function(e){ if(!e.target.result.objectStoreNames.contains('dxfFiles')) e.target.result.createObjectStore('dxfFiles',{keyPath:'name'}); };
        r.onsuccess=function(e){
          try{
            var db=e.target.result;
            if(!db.objectStoreNames.contains('dxfFiles')){ resolve({db:db,list:[]}); return; }
            var tx=db.transaction('dxfFiles','readonly');
            var store=tx.objectStore('dxfFiles');
            var out=[];
            var req=store.openCursor();
            req.onsuccess=function(ev){
              var cur=ev.target.result;
              if(cur){
                var v=cur.value;
                var sz=0;
                try{ sz=(v&&v.buf&&v.buf.byteLength)||0; }catch(e2){}
                out.push({name:v&&v.name,size:sz});
                cur.continue();
              } else {
                resolve({db:db,list:out});
              }
            };
            req.onerror=function(){ resolve({db:db,list:out}); };
          }catch(er){ resolve({db:null,list:[]}); }
        };
        r.onerror=function(){ resolve({db:null,list:[]}); };
      }catch(e){ resolve({db:null,list:[]}); }
    });
    if(!scan.list||scan.list.length===0){
      if(typeof showGuide==='function') showGuide('保存されているファイル本体がありません',2000);
      return;
    }
    var openKeys224={};
    if(typeof openFiles!=='undefined') openFiles.forEach(function(f){ if(f.fileKey) openKeys224[f.fileKey]=true; });
    var targets=scan.list.filter(function(r){ return r.name && !openKeys224[r.name]; });
    if(targets.length===0){
      if(typeof showGuide==='function') showGuide('削除対象(今開いていないファイル)がありません',2500);
      return;
    }
    var totalBytes=targets.reduce(function(a,r){return a+(r.size||0);},0);
    var mb=(totalBytes/1024/1024).toFixed(1);
    if(!confirm('今開いていないファイルの本体データ '+targets.length+'件('+mb+'MB)を削除します。\n書込み履歴・自動バックアップは削除されません。\nよろしいですか？')){
      return;
    }
    var db=scan.db;
    if(!db){
      if(typeof showGuide==='function') showGuide('削除に失敗しました',2000);
      return;
    }
    await new Promise(function(resolve){
      try{
        var tx=db.transaction('dxfFiles','readwrite');
        var store=tx.objectStore('dxfFiles');
        targets.forEach(function(r){ try{ store.delete(r.name); }catch(e){} });
        tx.oncomplete=function(){ resolve(); };
        tx.onerror=function(){ resolve(); };
      }catch(e){ resolve(); }
    });
    try{ db.close(); }catch(e){}
    if(typeof showGuide==='function') showGuide('本体データを削除しました('+targets.length+'件、'+mb+'MB)',3000);
  }catch(e){
    console.warn('[purge file bodies] failed',e);
    if(typeof showGuide==='function') showGuide('一括削除に失敗しました',2000);
  }
}
{var _purgeBtn224=document.getElementById('purgeUnopenedBtn224');
if(_purgeBtn224) _purgeBtn224.addEventListener('click',purgeUnopenedFileBodies224);}

// =========================================================
// V2_32: 全バックアップ復元。
// 「全バックアップ」(exportAllDvBackup223)で作った、複数ファイル分の書込み履歴が
// まとまったZIPを1つまたは複数選択して復元する。既存の「バックアップ復元」
// (importDxfviewManual)は1ファイル分(元図面+その.dxfview)専用で、全バックアップの
// ZIP(元図面を含まず、.dxfviewが多数入っている)を渡すと最初の1件しか反映されず
// 残りが無視されてしまう不具合があったための追加(既存の「バックアップ復元」自体は
// 変更しない)。
//
// 【想定用途】Safariが一定期間より古いデータを消してしまう場合に備え、定期的に
// 取っていた「全バックアップ」ZIP(例:1年前・今日)を全部まとめて読み込み、
// 抜け漏れなく書込み履歴を集約したい、というもの。
//
// 【マージ方針】
// 各ZIP内の.dxfviewは、dvストアのレコード(fk,fileName,fileSize,savedAt,dims,strokes等)
// をそのままJSON化したもの(exportAllDvBackup223参照)。同じfk(ファイル名+サイズ)の
// レコードが、複数のZIP・現在端末に既にあるデータの間で重複していた場合、
// savedAt(保存日時)が最も新しいものだけを残す。内容が完全に同じであれば結果的に
// どれを採用しても同じなので「全く同じデータは消して1つにする」動作にもなるし、
// 現在端末のデータより古い内容で誤って上書きされることもない(常に一番新しいものが残る)。
// 既存のIndexedDB(dv)の内容を書き足す/更新するだけで、ファイル本体・自動バックアップ・
// 検索インデックスには一切触れない。異なるfkのレコードは全て保持されるため、
// 実質的に複数回分のバックアップに含まれる全ファイルの書込み履歴が集約される。
// =========================================================
function _dvGetAll232(){
  return new Promise(function(resolve){
    try{
      var r=indexedDB.open('dxfViewerDxfviewDB',1);
      r.onupgradeneeded=function(e){ if(!e.target.result.objectStoreNames.contains('dv')) e.target.result.createObjectStore('dv',{keyPath:'fk'}); };
      r.onsuccess=function(e){
        try{
          var db=e.target.result;
          if(!db.objectStoreNames.contains('dv')){ resolve([]); return; }
          var tx=db.transaction('dv','readonly');
          var gr=tx.objectStore('dv').getAll();
          gr.onsuccess=function(){resolve(gr.result||[]);};
          gr.onerror=function(){resolve([]);};
        }catch(er){resolve([]);}
      };
      r.onerror=function(){resolve([]);};
    }catch(e){resolve([]);}
  });
}
function _dvPutAll232(recs){
  return new Promise(function(resolve,reject){
    try{
      var r=indexedDB.open('dxfViewerDxfviewDB',1);
      r.onupgradeneeded=function(e){ if(!e.target.result.objectStoreNames.contains('dv')) e.target.result.createObjectStore('dv',{keyPath:'fk'}); };
      r.onsuccess=function(e){
        var db=e.target.result;
        var tx=db.transaction('dv','readwrite');
        recs.forEach(function(rec){ tx.objectStore('dv').put(rec); });
        tx.oncomplete=function(){resolve();};
        tx.onerror=function(ev){reject(ev.target.error);};
      };
      r.onerror=function(e){reject(e.target.error);};
    }catch(e){reject(e);}
  });
}
async function importAllDvBackup232(){
  if(typeof JSZip==='undefined'){
    if(typeof showGuide==='function') showGuide('ZIP機能が読み込まれていません',2000);
    return;
  }
  var input=document.createElement('input');
  input.type='file';
  input.accept='.zip';
  input.multiple=true;
  input.onchange=async function(e){
    var files=Array.from(e.target.files||[]);
    if(files.length===0) return;
    if(!confirm(files.length+'個のZIPを読み込み、書込み履歴をまとめて復元します。同じファイルのデータが複数ある場合は、保存日時が新しい方を残します。よろしいですか？'))return;
    if(typeof showGuide==='function') showGuide('復元中…',2000);
    try{
      // 現在端末にあるデータも比較対象に含める(古いバックアップで誤って上書きしない)
      var allRecs=await _dvGetAll232();
      var zipFileCount=0, zipRecCount=0;
      for(var fi=0; fi<files.length; fi++){
        var f=files[fi];
        if(!f.name.toLowerCase().endsWith('.zip')) continue;
        try{
          var zipObj=await JSZip.loadAsync(f);
          var names=Object.keys(zipObj.files);
          for(var ni=0; ni<names.length; ni++){
            var nm=names[ni];
            if(!nm.toLowerCase().endsWith('.dxfview')) continue;
            var txt=await zipObj.files[nm].async('string');
            try{
              var rec=JSON.parse(txt);
              if(rec&&rec.fk){ allRecs.push(rec); zipRecCount++; }
            }catch(pe){ console.warn('[all dv restore] parse error',nm,pe); }
          }
          zipFileCount++;
        }catch(ze){
          console.warn('[all dv restore] zip read error',f.name,ze);
          alert('『'+f.name+'』の読み込みに失敗しました。他のZIPの処理は続けます。');
        }
      }
      if(zipFileCount===0){
        alert('有効なZIPファイルがありませんでした');
        return;
      }
      // fk(ファイル名+サイズ)ごとにグループ化し、savedAtが最も新しいものだけ残す
      var byFk={};
      allRecs.forEach(function(rec){
        var cur=byFk[rec.fk];
        if(!cur){ byFk[rec.fk]=rec; return; }
        var curT=Date.parse(cur.savedAt||0)||0;
        var newT=Date.parse(rec.savedAt||0)||0;
        if(newT>curT) byFk[rec.fk]=rec;
      });
      var mergedRecs=Object.keys(byFk).map(function(k){return byFk[k];});
      await _dvPutAll232(mergedRecs);
      if(typeof showGuide==='function') showGuide('全バックアップ復元が完了しました('+zipFileCount+'個のZIP、'+zipRecCount+'件読込→'+mergedRecs.length+'件に統合)',3500);
      if(typeof verify==='function') verify('全バックアップ復元',{zipFileCount:zipFileCount,zipRecCount:zipRecCount,mergedCount:mergedRecs.length});
    }catch(err){
      console.warn('[all dv restore] failed',err);
      alert('全バックアップ復元に失敗しました: '+err.message);
    }
  };
  input.click();
}
{var _allDvRestoreBtn232=document.getElementById('allDvRestoreBtn232');
if(_allDvRestoreBtn232) _allDvRestoreBtn232.addEventListener('click',importAllDvBackup232);}

// =========================================================
// V0_136: バックアップ復元（設定パネルボタン、旧名称:書込復元）
// .dxfview ファイルを選択して strokes / dims / savedViews / hiddenLayers を復元
// V1_176: 元DXFと.dxfviewをまとめたZIP(V1_176以降のバックアップ)にも対応。
// 旧バージョンで保存した単体の.dxfviewファイルもそのまま復元できる(後方互換)
// V1_177: ZIPの場合、書込みデータだけでなく中に同梱されている元DXF(またはtdf)自体も
// 新しいタブとして開いた上で書込みデータを適用するよう変更(旧:現在開いているファイルに
// 書込みデータだけ適用。元ファイルを手元で開き直しておく必要があった)
// =========================================================
function importDxfviewManual(){
  var input=document.createElement('input');
  input.type='file';
  input.accept='.dxfview,.zip';
  input.onchange=function(e){
    var file=e.target.files[0];
    if(!file)return;
    var isZip176=file.name.toLowerCase().endsWith('.zip');
    if(isZip176){
      // V1_191: PDFのバックアップにも対応した旨をわかりやすくするため文言を更新
      // (復元処理自体はV1_177から拡張子非依存でPDFにも対応済みだった)
      if(!confirm('ZIP内の図面(DXF/PDF/tdf)を開き、書込みデータも復元します。よろしいですか？'))return;
      if(typeof JSZip==='undefined'){
        showGuide('ZIP機能が読み込まれていません',2000);return;
      }
      JSZip.loadAsync(file).then(async function(zipObj){
        var names=Object.keys(zipObj.files);
        // V1_179: 原因切り分けのため、ZIP内の実際のファイル一覧を必ず記録しておく
        verify('バックアップ復元:zip内容',{names:names});
        var dvName=names.find(function(n){return n.toLowerCase().endsWith('.dxfview');});
        if(!dvName){
          // V1_214: 自社の.dxfviewが無い場合、旧アプリ「M_VIEWER」独自のバックアップZIP
          // (PDF + strokes.json + meta.json)かどうかを判定する。M_VIEWERを使っていた人が
          // このアプリに切り替えた際、手書き・蛍光ペンの書込みをそのまま取り込めるようにする
          var mvStrokesName=names.find(function(n){return n.toLowerCase()==='strokes.json';});
          if(mvStrokesName){
            await _importMViewerZip214(zipObj,names,mvStrokesName);
            return;
          }
          alert('ZIP内に.dxfviewファイルが見つかりません。\nZIP内のファイル: '+names.join(', '));return;
        }
        // V1_177: .dxfview以外の1件を元図面(DXF/tdf)として扱う
        var drawName=names.find(function(n){return n!==dvName;});
        var dvText=await zipObj.files[dvName].async('string');
        var _drawOpened179=false;
        if(drawName){
          var drawBuf=await zipObj.files[drawName].async('arraybuffer');
          // V1_178: 同名だが内容(サイズ)が異なるタブが既に開いている場合、
          // openDxfFromDb内の「二重オープン防止」ガードに引っかかり、ZIP内のDXFを
          // 読み込まずに既存の古いタブへ切り替えるだけで終わってしまう不具合を修正。
          // この場合、書込みデータ自体は復元されるが古い図面の表示位置に適用されるため、
          // 「DXFは開くが書込みが表示されない(実際は画面外にある)」ように見えていた。
          // 復元時は必ずZIP内のDXFを正として開き直したいので、同名の古いタブは先に閉じる。
          if(typeof openFiles!=='undefined'&&typeof _fileKey==='function'){
            var _fkNew178=_fileKey(drawName,drawBuf.byteLength);
            var _staleIdx178=openFiles.findIndex(function(x){
              return (x.currentFileName||x.name)===drawName && x.fileKey!==_fkNew178;
            });
            if(_staleIdx178>=0&&typeof doCloseTab==='function'){
              doCloseTab(_staleIdx178);
            }
          }
          if(typeof openDxfFromDb==='function'){
            await openDxfFromDb(drawName,drawBuf);
            _drawOpened179=true;
          } else {
            alert('図面を開く機能が読み込まれていません');return;
          }
        } else {
          // V1_179: 見落とされやすいため、消えるガイドではなくalertで必ず気づけるようにする
          alert('このZIPには元図面(DXF/tdf)が同梱されていません。\nZIP内のファイル: '+names.join(', ')+'\n書込みデータのみ、現在開いているファイルに復元します。');
        }
        _applyDxfviewJson176(dvText,{drawName:drawName,drawOpened:_drawOpened179});
      }).catch(function(err){
        console.warn('[dxfview import zip] failed',err);
        alert('ZIP読み込みに失敗しました: '+err.message);
      });
      return;
    }
    // V1_177: 旧形式(.dxfview単体)は元図面を同梱していないため、従来通り
    // 「現在開いているファイルに書込みデータだけ適用する」動作のまま維持する
    if(!confirm('現在の書込み内容は上書きされます。よろしいですか？'))return;
    var reader=new FileReader();
    reader.onload=function(ev){ _applyDxfviewJson176(ev.target.result); };
    reader.readAsText(file,'UTF-8');
  };
  input.click();
}
// V1_176: importDxfviewManualから.dxfview形式のJSON文字列を受け取り、実際にstrokes/dims等へ
// 適用する処理を切り出した共通関数(旧FileReader経路・新ZIP経路の両方から呼ばれる)
function _applyDxfviewJson176(jsonText,_meta179){
      try{
        var d=JSON.parse(jsonText);
        if(!d||!d.format||(d.format!=='dxfview'&&d.format!=='dxfview-backup')){
          alert('無効な.dxfviewデータです(format='+(d&&d.format)+')');return;
        }
        if(typeof snapshot==='function')snapshot();
        if(typeof strokes!=='undefined') strokes=d.strokes||[];
        if(typeof dims!=='undefined') dims=d.dims||[];
        if(typeof savedViews!=='undefined'){
          var sv=d.savedViews||[];
          savedViews=[sv[0]||null,sv[1]||null,sv[2]||null,sv[3]||null,sv[4]||null];
        }
        if(typeof hiddenLayers!=='undefined'&&d.hiddenLayers){
          hiddenLayers=new Set(d.hiddenLayers);
        }
        // V0_141.2: 再代入で参照エイリアスが切れるためopenFiles[]に明示同期（V0_140対応）
        // 同期しないと自動保存(_doBkSave/_dvAutoSave/doSave)が旧データを読み、
        // 復元内容が上書き消失・タブ切替で復元前に戻るバグが発生する
        if(typeof openFiles!=='undefined'&&typeof currentFileIdx!=='undefined'&&
           currentFileIdx>=0&&openFiles[currentFileIdx]){
          var _rf141=openFiles[currentFileIdx];
          if(typeof strokes!=='undefined')_rf141.strokes=strokes;
          if(typeof dims!=='undefined')_rf141.dims=dims;
          if(typeof savedViews!=='undefined')_rf141.savedViews=savedViews;
          if(typeof hiddenLayers!=='undefined')_rf141.hiddenLayersArr=Array.from(hiddenLayers);
        }
        // UI更新
        for(var i=0;i<5;i++){if(typeof updateViewmemoState==='function')updateViewmemoState(i);}
        if(typeof buildLayerModal==='function')buildLayerModal();
        if(typeof scheduleDraw==='function')scheduleDraw(); // V0_138: 書込復元後にDXF本体Canvasを再描画
        if(typeof scheduleOverlay==='function')scheduleOverlay();
        if(typeof updateUndoRedo==='function')updateUndoRedo();
        // V0_142: scheduleSave()→doSave()直接呼び出しに変更
        // 復元直後にSafariを閉じると800msデバウンスが間に合わずデータ消失するバグを修正
        if(typeof doSave==='function') doSave();
        else if(typeof scheduleSave==='function')scheduleSave();
        if(typeof verify==='function')verify('バックアップ復元:done');
        _abMarkSaved(); // V0_141.2: 復元後はバックアップ済みとしてリセット
        // V1_178: 復元件数を表示し、「復元はしたが実際は0件だった」等をその場で判別できるようにする
        // V1_179: 「表示されない」報告が続いたため、消えるガイドではなくalertで
        // 図面の同梱有無・復元件数を必ず確認できるようにした(原因切り分け用)
        var _sCnt178=(d.strokes||[]).length, _dCnt178=(d.dims||[]).length;
        if(_meta179){
          var _msg179='書込みデータを復元しました\n'
            +'図面: '+(_meta179.drawOpened?('ZIP内の「'+_meta179.drawName+'」を開きました'):'ZIP内の図面は開いていません(現在表示中のファイルに適用)')+'\n'
            +'線・図形: '+_sCnt178+'件 / 寸法: '+_dCnt178+'件';
          if(_sCnt178===0&&_dCnt178===0){
            _msg179+='\n\n※復元件数が0件です。このバックアップ作成時点で書込み内容が保存されていなかった可能性があります。';
          }
          // V1_214: M_VIEWERバックアップ変換時の補足(消しゴム線のスキップ件数等)があれば追記する
          if(_meta179.extraNote) _msg179+='\n\n'+_meta179.extraNote;
          alert(_msg179);
        } else {
          showGuide('書込みデータを復元しました(線・図形:'+_sCnt178+'件 寸法:'+_dCnt178+'件)',2500);
        }
      }catch(err){
        console.warn('[dxfview import] failed',err);
        alert('.dxfview読み込みに失敗しました: '+err.message);
      }
}

// =========================================================
// V1_214: 旧アプリ「M_VIEWER」のバックアップZIP取り込み
// M_VIEWERの「バックアップ」機能は、元PDF + strokes.json(ページ番号ごとの
// 手書き/蛍光ペン配列) + meta.json(ファイル名・表示ページ・拡大率等)を1つの
// ZIPにまとめる形式。DXF Viewerの.dxfview-backup形式とは中身が異なるため、
// strokes.jsonを検出したらこちらの専用変換処理を通す。
//
// 座標系: M_VIEWERのpoints([[x,y],...])はPDFの生ユーザー空間(回転前、Y上向き)の
// まま保存されている。DXF Viewerの「ワールド座標」はpdf.jsのgetViewport()
// (ページの/Rotateを反映した表示用フレーム)を基準にしており、/Rotateが
// 0度のPDFでは生PDF座標と一致するが、90/180/270度回転PDFでは一致しない
// (V1_196のHD-PDF書出し修正時に判明した既知の仕様、export.js:_hpMakeRawMapper196
// 参照)。そのため、_hpMakeRawMapper196の逆変換(生PDF座標→ワールド座標)を
// ページごとに用意して変換する。
//
// 線幅: M_VIEWER側はdrawStroke()で lineWidth(canvas px) = size * sc/3
// (sc=PDF座標→canvas pxの倍率)としており、これは常に size/3 (PDFポイント単位)
// という不変の物理幅を表す。DXF Viewer側はdrawAnnotation()で
// lineWidth(device px) = s.lw * (scale/fitScale) * dpr としており、こちらは
// s.lw/fitScale という物理幅(ワールド単位=PDFポイントと同一)を表す。
// 両者の物理幅を一致させると lw = fitScale * size/3 となる（ページごとに
// fitScaleを求めて変換する。複数ページで用紙サイズが異なる場合にも対応するため、
// 実際にページを切り替えず、fit()と同じ計算式をページごとに再現する）。
function _mvHexToRgbObj214(hex){
  var h=(hex||'#000000').replace('#','');
  if(h.length===3) h=h.split('').map(function(c){return c+c;}).join('');
  var r=parseInt(h.slice(0,2),16), g=parseInt(h.slice(2,4),16), b=parseInt(h.slice(4,6),16);
  return {r:isFinite(r)?r:0, g:isFinite(g)?g:0, b:isFinite(b)?b:0};
}
// 生PDF座標(rx,ry)→ワールド座標(wx,wy)。_hpMakeRawMapper196(このファイル内、上部)の
// 逆変換。vp=page.getViewport({scale:1})(/Rotate込みの表示用フレーム)
function _mvMakeWorldMapper214(vp){
  function pt(rx,ry){
    var v=vp.convertToViewportPoint(rx,ry); // Y下向き・vp原点(左上)のビューポート座標
    return {x:v[0], y:vp.height-v[1]};       // renderPdfPage()のpdfImage定義と同じ規約(Y上向き)へ
  }
  return {pt:pt};
}
// 指定ページを実際に開き直さずに、そのページのfitScale相当値を求める(fit()と同じ計算式)
function _mvComputeFitScaleForPage214(vp){
  var dpr=window.devicePixelRatio||1;
  var W=cv.width/dpr, H=cv.height/dpr;
  var dw=vp.width, dh=vp.height;
  if(dw<1e-10||dh<1e-10) return 1;
  var margin=0.005; // V1_172のfit()と同じ余白
  return Math.min(W*(1-2*margin)/dw, H*(1-2*margin)/dh);
}
async function _importMViewerZip214(zipObj,names,mvStrokesName){
  try{
    if(!confirm('M_VIEWERのバックアップZIPを検出しました。PDFを開き、手書き・蛍光ペンの書込みを変換して取り込みます。よろしいですか？')) return;
    var pdfName=names.find(function(n){return n.toLowerCase().endsWith('.pdf');});
    if(!pdfName){
      alert('ZIP内にPDFが見つかりません。\nZIP内のファイル: '+names.join(', '));return;
    }
    var mvMetaName=names.find(function(n){return n.toLowerCase()==='meta.json';});
    var strkText=await zipObj.files[mvStrokesName].async('string');
    var metaData=mvMetaName?JSON.parse(await zipObj.files[mvMetaName].async('string')):null;
    var strkData=JSON.parse(strkText||'{}');
    var pdfBuf=await zipObj.files[pdfName].async('arraybuffer');

    // 同名だが内容が異なる古いタブが開いていれば閉じる(既存の.dxfview復元と同じ対応)
    if(typeof openFiles!=='undefined'&&typeof _fileKey==='function'){
      var _fkNew214=_fileKey(pdfName,pdfBuf.byteLength);
      var _staleIdx214=openFiles.findIndex(function(x){
        return (x.currentFileName||x.name)===pdfName && x.fileKey!==_fkNew214;
      });
      if(_staleIdx214>=0&&typeof doCloseTab==='function') doCloseTab(_staleIdx214);
    }
    if(typeof openDxfFromDb!=='function'){ alert('図面を開く機能が読み込まれていません');return; }
    // メタの表示ページがあればそのページで開く(無ければ1ページ目)
    var startPage=(metaData&&metaData.curPage>=1)?metaData.curPage:1;
    await openDxfFromDb(pdfName,pdfBuf,null,null,startPage);
    if(!pdfDoc){ alert('PDFの読み込みに失敗しました');return; }

    // ページごとにワールド座標変換・fitScaleを計算(初回参照時にキャッシュ)
    var _pageCtxCache={};
    async function getPageCtx(pageNum){
      if(_pageCtxCache[pageNum]) return _pageCtxCache[pageNum];
      var page=await pdfDoc.getPage(pageNum);
      var vp=page.getViewport({scale:1});
      var ctx={mapper:_mvMakeWorldMapper214(vp),fitScale:_mvComputeFitScaleForPage214(vp)};
      _pageCtxCache[pageNum]=ctx;
      return ctx;
    }

    var convertedStrokes=[];
    var eraserSkipped=0, pageSkipped=0;
    var pageKeys=Object.keys(strkData||{});
    for(var pki=0;pki<pageKeys.length;pki++){
      var pageNum=parseInt(pageKeys[pki],10);
      if(!pageNum||pageNum<1||pageNum>pdfDoc.numPages){ pageSkipped+=((strkData[pageKeys[pki]]||[]).length); continue; }
      var arr=strkData[pageKeys[pki]]||[];
      var pctx;
      try{ pctx=await getPageCtx(pageNum); }catch(pe214){ pageSkipped+=arr.length; continue; }
      for(var si214=0;si214<arr.length;si214++){
        var s=arr[si214];
        if(!s||!s.points||s.points.length<2) continue;
        if(s.type==='eraser'){ eraserSkipped++; continue; } // 消しゴム線はDXF Viewerの描画方式では再現不可のためスキップ
        if(s.type!=='pen'&&s.type!=='hl') continue; // v16のtext/shape等は対象外
        var pts214=s.points.map(function(p){ return pctx.mapper.pt(p[0],p[1]); });
        var sizeNum=(typeof s.size==='number'&&s.size>0)?s.size:3;
        var lw214=pctx.fitScale*(sizeNum/3);
        var strokeObj={pts:pts214,color:_mvHexToRgbObj214(s.color),lw:lw214,page:pageNum};
        if(s.type==='hl') strokeObj.hl=true;
        convertedStrokes.push(strokeObj);
      }
    }

    var payload214={
      format:'dxfview-backup',version:1,
      strokes:convertedStrokes,dims:[],
      savedViews:[null,null,null,null,null],hiddenLayers:[]
    };
    var noteParts=[];
    if(eraserSkipped>0) noteParts.push('※消しゴム線'+eraserSkipped+'件は、このアプリの描画方式では再現できないためスキップしました');
    if(pageSkipped>0) noteParts.push('※対象ページが見つからない書込み'+pageSkipped+'件をスキップしました');
    _applyDxfviewJson176(JSON.stringify(payload214),{drawName:pdfName,drawOpened:true,extraNote:noteParts.join('\n')});
  }catch(err){
    console.warn('[M_VIEWER import] failed',err);
    alert('M_VIEWERバックアップの取り込みに失敗しました: '+err.message);
  }
}
document.getElementById('importDxfviewBtn').addEventListener('click',importDxfviewManual);

// =========================================================
// V0_141.2: 自動バックアップ促進システム
// iPad Safari ではプログラムからのファイル自動保存が不可能なため、
// 10分ごとに変更を検知し「今すぐ保存」バナーを表示する。
// ユーザーが1タップすると exportDxfviewManual() を実行。
// =========================================================
// V0_142: _AB_INTERVAL_MS 削除（visibilitychange方式に変更したため不要）
var _abLastSavedSig = null;            // 最後にバックアップした時点のシグネチャ (null=未計測)
var _abBannerEl    = null;             // バナー要素の参照

// 現在の書込み量をシグネチャ文字列で返す（strokes数:dims数）
function _abGetSig() {
  var s = (typeof strokes !== 'undefined' && strokes) ? strokes.length : 0;
  var d = (typeof dims    !== 'undefined' && dims)    ? dims.length    : 0;
  return s + ':' + d;
}

// バックアップ完了時に呼ぶ（タイマーリセット + バナー非表示）
function _abMarkSaved() {
  _abLastSavedSig = _abGetSig();
  _abHideBanner();
}

// バナーを非表示にして DOM から除去
function _abHideBanner() {
  if (_abBannerEl && _abBannerEl.parentNode) {
    _abBannerEl.parentNode.removeChild(_abBannerEl);
  }
  _abBannerEl = null;
}

// 「今すぐ保存」バナーを表示
function _abShowBanner() {
  if (_abBannerEl) return; // すでに表示中なら何もしない
  var el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'bottom:72px',          // ツールバー・ホームインジケータを避ける
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:99998',
    'background:rgba(20,26,38,0.97)',
    'border:2px solid #f5a623',
    'border-radius:14px',
    'padding:12px 14px 12px 16px',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'box-shadow:0 6px 32px rgba(0,0,0,0.75)',
    'font-family:-apple-system,Helvetica Neue,sans-serif',
    'max-width:92vw',
    'width:340px',
    'box-sizing:border-box'
  ].join(';');

  el.innerHTML =
    '<span style="color:#f5a623;font-size:20px;flex-shrink:0;">⚠</span>' +
    '<span style="color:#dde2f4;font-size:13px;line-height:1.5;flex:1;">' +
      '書込みデータが未バックアップです<br>' +
      '<span style="color:#8898bb;font-size:11px;">ファイルに保存してください（10分経過）</span>' +
    '</span>' +
    '<button id="_abSaveBtn" style="' +
      'background:#f5a623;color:#1e2430;border:none;border-radius:8px;' +
      'padding:9px 14px;font-size:13px;font-weight:700;cursor:pointer;' +
      'white-space:nowrap;flex-shrink:0;' +
    '">今すぐ保存</button>' +
    '<button id="_abDismissBtn" style="' +
      'background:transparent;color:#556;border:none;' +
      'font-size:20px;cursor:pointer;padding:0 2px;line-height:1;flex-shrink:0;' +
    '">×</button>';

  document.body.appendChild(el);
  _abBannerEl = el;

  // 「今すぐ保存」: exportDxfviewManual() を実行（成功時に _abMarkSaved が呼ばれる）
  el.querySelector('#_abSaveBtn').addEventListener('click', function() {
    exportDxfviewManual();
  });
  // 「×」: バナーを閉じる（次の10分チェックで再表示される可能性あり）
  el.querySelector('#_abDismissBtn').addEventListener('click', function() {
    _abHideBanner();
  });
}

// 10分ごとに変更の有無を確認
function _abCheck() {
  var cur = _abGetSig();
  // 初回チェック時: 現在の状態を「保存済み」として記録しバナーを出さない
  if (_abLastSavedSig === null) {
    _abLastSavedSig = cur;
    return;
  }
  // 変更があればバナーを表示
  if (cur !== _abLastSavedSig) {
    _abShowBanner();
  }
}

// V0_142: 10分タイマー → visibilitychange に変更
// ページが非表示になった時（Safari離脱・アプリ切替）にトリガー
// ① 未保存のdebounce中データを doSave() で即時フラッシュ
// ② V1_193: 「10分間隔で出るバックアップして、というポップアップを中止してほしい」
//    との要望により、_abCheck()(「今すぐ保存」バナー表示)の呼び出しを削除した。
//    データ消失防止のための①doSave()即時フラッシュは通知の有無に関わらず必要な
//    処理のため維持している。_abCheck/_abShowBanner等の関数定義自体は既存機能
//    保護のため残しており(呼び出し元がここだけなので通常は使われなくなるが)、
//    _abMarkSaved()は他の保存成功箇所からも呼ばれる内部状態更新用のため無関係
document.addEventListener('visibilitychange', function() {
  if (document.hidden) {
    // 800msデバウンス中のsaveTimerが未発火でも即時保存（データ消失防止）
    // V0_144: currentFileNameガード追加（ファイル未読込時にdoSaveすると空データで保存を上書きし消失するため。V0_132のHTML側ハンドラと同一パターン）
    try { if(typeof doSave==='function' && typeof currentFileName!=='undefined' && currentFileName) doSave(); } catch(e) {}
  }
});

// V0_154で削除されたHD-PDF書出（試験）機能を、文字幅補正Phase1つきでV1_151で復元。
// V1_152: V1_151で報告された2つの不具合(生成直後にPDF閲覧側が黒画面になる/文字が
//   ほぼ見えない)に対応。
// V1_153: 文字サイズ計算の見直し(mm基準に変更)・A3化・線種(点線等)反映・
//   文字幅補正の安全域を狭めて太さを緩和。
// V1_154: 埋め込み日本語フォントを548文字サブセット→6886文字収録のNoto Sans JPに差替え。
// V1_155: 【書き込みのベクター化】これまで手書き(strokes)・寸法(dims)は透過PNG
//   ラスター画像として重ねていたが、大きなラスター画像を埋め込むこと自体が
//   V1_151〜152で対応した「閲覧側が黒画面になる」不具合の根本要因だった。
//   strokes・dimsは元々ワールド座標の点列・線分データとして保持されているため、
//   全てjsPDFのベクターパス(pdf.lines()での3次ベジェ近似・直線・矢印三角形)として
//   描画するよう変更した。これによりHD-PDFは（DXF由来の画像を除き）完全ベクターの
//   PDFになり、大きなラスター画像を一切埋め込まなくなったため、黒画面の原因となる
//   巨大画像の展開負荷そのものが構造的に無くなった。
//   あわせて、ラスター化のために用意していた作業用Canvas・メモリ見積り・実測
//   アロケーションテスト・devicePixelRatio/tx/ty/scaleの一時差し替えは全て不要に
//   なったため削除した(LONG_PXはCanvasを実際には作らない、スケール計算専用の
//   参照値に変更)。
//   埋め込みフォントもRegular(400)→Light(300)に変更し「文字が少し太い」との
//   指摘に対応した(文字セットのカバー範囲はV1_154と同じ)。
// V1_156: 【文字欠落】「～」(全角チルダ、Unicode U+FF5E)がPDFで表示されない不具合を
//   修正。DXFデータはWindows製CAD由来のためJIS/CP932の全角チルダ(U+FF5E)を使うことが
//   多いが、埋め込みフォント(Google Fonts Noto Sans JP)の日本語サブセットは
//   Unicode標準の波ダッシュ(U+301C)しか収録していない。jsPDFは埋め込みフォントに
//   無い文字を警告もなく無音で読み飛ばすため、「10～20」が「1020」のように文字が
//   消えたまま表示されていた(実測: PDFのTj内容を確認し、U+FF5Eのみ欠落してグリフが
//   1つ減っていることを確認)。フォントを追加せず、pdf.text()/getTextWidth()に渡す
//   直前でU+FF5E→U+301C、同種のU+2015(全角ダッシュ)→U+2014に置換するヘルパー
//   (_hpFixChars)を追加し、doc.moji・dims文字の両方に適用した。見た目はほぼ同一の
//   文字に単純置換するだけなので、実際の寸法値や記号の意味は変わらない。
//   【寸法の矢印・文字の重なり】ごく短い区間の寸法(例: 実寸2.75mm相当など)で、
//   矢印同士・矢印と文字が重なって判読できなくなる不具合を修正。V1_155では矢印長・
//   矢印幅・寸法線幅・センターマークを固定mm値としていたため、図面全体をA3用紙に
//   収める際の縮小率が大きい(＝一枚のシートに長大な図面を収める)場合、実寸が
//   小さい寸法ほど矢印サイズが相対的に大きくなり重なりやすかった。V1_151以前の
//   画面表示ロジック(dimensionTextMode='fixed'時、worldFontH*scaleに比例して矢印・
//   線幅も縮小する)と同じ考え方に戻し、矢印長・矢印幅・寸法線幅・センターマーク・
//   文字とのオフセットを全て寸法文字サイズ(fsMM、worldFontHに比例)基準の相対値に
//   変更した。これにより極小スケールの寸法では矢印・線も連動して小さくなり、
//   重なりを避けやすくなる。
// V1_157: 「スクショの画面表示とPDF印刷の文字の見た目の違いが大きい」との指摘に対応。
//   これまでDXF文字(doc.moji)・寸法文字(dims)とも、英数字を含む文字列全体を単一の
//   埋め込みフォント(Noto Sans JP Light300)で描画していた。画面側は英数字も含めて
//   ブラウザの既定sans-serif(Helvetica/Arial系)で表示されるため、特に数字の字形・
//   字幅がPDFと画面とで大きく異なって見えていた。本バージョンでは、文字列を
//   ASCII文字(半角英数字・記号、コードポイント0x7E以下)の連続部分と、それ以外
//   (漢字・かな・全角記号)の連続部分とに分割し、ASCII部分はjsPDF内蔵のHelvetica
//   フォントで、それ以外はNoto Sans JP埋め込みフォントで、それぞれ描画するように
//   変更した(_hpSplitRuns)。文字列中で複数回フォントが切り替わる場合も、各区間の
//   実測幅をjsPDFのネイティブ回転規約(角度θ度に対し水平方向の送りベクトルは
//   (cosθ, -sinθ)、実測してjsPDF自身のalign:'center'と一致することを確認済み)で
//   連続的に積み上げて描画位置を求めるため、回転や複数行が付いた文字でも隙間なく
//   連結して表示される。文字列全体の画面幅とPDF幅の比率(horizontalScale補正)も、
//   各区間をそれぞれ正しいフォントで実測した合計値を基準に計算し直すため、より
//   正確な補正になる。
// V1_158: 「文字がたくさん書いた図面になるとPDFの時に文字が大きくなりすぎて、
//   ぐちゃぐちゃになる」との指摘に対応。ユーザー提供のPDF(A1版・縮尺1/200を想定した
//   広域・高密度な部材リスト付きDXF、部材ラベルが約2000個)を実測したところ、
//   実に2024個中2001個のテキストが、DXF文字の最低文字高フロア(MIN_TEXT_MM=2.2mm、
//   V1_153で「文字が出てこない」不具合対策として導入)にちょうど張り付いていた。
//   図面全体を固定ページ長辺のA3に収める都合上、この図面のように広域・高密度な
//   図面ほど本来の縮尺で計算される文字サイズが小さくなるが、2.2mmという下限が
//   「完全に不可視化することを防ぐ安全弁」の役割を超えて、ほぼ全ての文字を
//   一律に本来より大きく引き伸ばしてしまい、狭い間隔に並ぶ多数のラベルが
//   重なり合って判読不能になっていた。DXF文字(doc.moji)のMIN_TEXT_MM、寸法文字
//   (dims)のDIM_MIN_TEXT_MMをともに2.2mm→1.1mmへ引き下げた。この下限値は
//   「完全な不可視化を防ぐ」目的に立ち返った安全弁として、密な図面での重なりを
//   大きく緩和しつつ、極端に小さい文字が完全に消えてしまうことは防ぐバランスで
//   設定している。なお、密な図面ほど本来の縮尺自体が小さいため、下限を下げても
//   なお文字が小さく感じられる場合はあり得るが、これは1枚のA3に図面全体を収める
//   という仕様上の制約によるものである。
// V1_159: V1_158(フロア1.1mm)適用後、ユーザーからPDFとアプリ画面のスクリーン
//   ショットを提供いただき比較した結果、「階段6」のように複数のDXF文字ラベルが
//   世界座標上で近接して並ぶ箇所で、PDF側はラベル同士がアプリ画面より詰まって
//   見えることを確認した。DXF原本は特定の縮尺(A1版1/200等)で重ならないよう
//   文字高と行間隔の比率が設計されているため、本来はフロアで引き伸ばさず
//   e.h*pdfScale*_sxをそのまま使えば、ラベル同士の間隔と文字高が同じ比率で
//   縮小されて重なりが生じないはずである。しかし前バージョンまでのフロア値
//   (1.1mm)がこの自然な比率より大きい場合、フロアで一律に引き伸ばされた文字が
//   本来の行間隔を超えてしまい、なお重なりが残っていた。PDFはベクター形式で
//   PDFビューア側から自由に拡大できるため、密な図面では「フロアで無理に読みやすい
//   大きさへ引き伸ばす」よりも「元の縮尺どおりの比率を保ち、必要なら閲覧側で
//   拡大してもらう」方が重なりを避けやすいと判断し、DXF文字(doc.moji)の
//   MIN_TEXT_MM、寸法文字(dims)のDIM_MIN_TEXT_MMをともに1.1mm→0.6mmへさらに
//   引き下げた。完全な不可視化(V1_152の実測不具合値は約0.1mm)を防ぐ安全弁としての
//   役割は0.6mmでも6倍以上の余裕があり十分に果たせる。
// V1_160: 「寸法の数字が若干PDFにすると小さくなります」との指摘に対応。ユーザー
//   提供のPDF(2B-034_hd.pdf)の内部データを実測したところ、寸法値(dims)の
//   テキスト13個のうち5個が、V1_159で0.6mmに揃えたDIM_MIN_TEXT_MMにちょうど
//   張り付いており(1.7007874pt=0.6mm)、周囲のDXF文字(黒、この図面では大半が
//   約4.08pt≒1.44mm相当)や、床に張り付いていない他の寸法値(約2.07〜6.57pt=
//   0.73〜2.3mm相当)より明らかに小さく浮いて見えていた。dimsはユーザーが寸法を
//   作成した時点のワールド座標系での文字高(worldFontH)を記録しており、画面表示
//   (dimensionTextMode='fixed')でもズームに依存せず一定の見やすさで表示される
//   設計になっているため、doc.moji(V1_159で密な図面での重なり対策として0.6mmに
//   下げた)とは別に、dims専用の下限を引き上げるのが適切と判断した。
//   DIM_MIN_TEXT_MM(dims専用)を0.6mm→1.2mmへ引き上げ、MIN_TEXT_MM(doc.moji用、
//   V1_158/159の密な図面対策)は0.6mmのまま変更していない。
// =========================================================
var _jpFontLoaded=false;
function _loadJPFont(){
  return new Promise(function(resolve){
    if(_jpFontLoaded||window._notoSansJPBase64){_jpFontLoaded=true;resolve();return;}
    var s=document.createElement('script');
    s.src='./fonts/NotoSansJP.js';
    s.onload=function(){_jpFontLoaded=true;resolve();};
    s.onerror=function(){console.warn('[HybridPDF] フォント読み込み失敗');resolve();};
    document.head.appendChild(s);
  });
}

// V1_151: 画面表示フォント(sans-serif)での文字列幅測定用の使い回しcanvas
var _hpMeasureCv=null,_hpMeasureCtx=null;

// V1_155: canvasのctx.rotate(angle)と同じ回転（Y下向き画面空間、標準的な回転行列）。
// 書き込み(矢印・寸法文字の下線)のベクター化で、画面描画と同じ見た目になるよう
// ローカル座標を回転させてから配置するために使用する
function _hpRotPt(lx,ly,angle){
  const c=Math.cos(angle),s=Math.sin(angle);
  return [lx*c-ly*s, lx*s+ly*c];
}

// V1_155: 寸法の色(d.color、'#rrggbb'形式のCSS16進文字列)をr,g,bに変換
function _hpHexColor(hex){
  var h=(hex||'#f39c12').replace('#','');
  if(h.length===3) h=h.split('').map(function(c){return c+c;}).join('');
  var r=parseInt(h.slice(0,2),16), g=parseInt(h.slice(2,4),16), b=parseInt(h.slice(4,6),16);
  return [isFinite(r)?r:0, isFinite(g)?g:0, isFinite(b)?b:0];
}

// V1_156: 埋め込みフォント(Noto Sans JP 日本語サブセット)に収録が無く、jsPDFが
// 無音で読み飛ばしてしまう一部のWindows/CP932由来の記号を、見た目がほぼ同一の
// Unicode標準の文字へ置換してから描画・幅測定する。実測でU+FF5E(全角チルダ「～」)が
// 欠落することを確認したため対応。同種のU+2015(全角ダッシュ「―」)も念のため含める
function _hpFixChars(s){
  if(!s) return s;
  return s.replace(/～/g,'〜').replace(/―/g,'—');
}

// V1_157: 文字列をASCII文字(半角英数字・記号、コードポイント0x7E以下)の連続部分と
// それ以外(漢字・かな・全角記号)の連続部分に分割する。ASCII部分は画面と同じ
// 系統のHelveticaで、それ以外はNoto Sans JP埋め込みフォントで描画するための下準備
function _hpSplitRuns(s){
  const runs=[];
  let cur='', curFont=null;
  for(const ch of (s||'')){
    const cp=ch.codePointAt(0);
    const f=(cp<=0x7E)?'ascii':'jp';
    if(f!==curFont){
      if(cur) runs.push({text:cur,font:curFont});
      cur=ch; curFont=f;
    }else{
      cur+=ch;
    }
  }
  if(cur) runs.push({text:cur,font:curFont});
  return runs;
}
// V1_157: ランのフォント種別に応じてjsPDFの現在フォントを切り替える
function _hpSetRunFont(pdf,font){
  if(font==='ascii') pdf.setFont('helvetica','normal');
  else pdf.setFont('NotoSansJP','normal');
}
// V1_157: jsPDFのpdf.text()にoptions.angle(度)を渡した場合の実際の送りベクトルを
// 実測・検証済みの式で計算する(ローカル+x方向に距離wだけ進んだ位置は
// (w*cosθ, -w*sinθ)だけオフセットされる。jsPDFのalign:'center'と実測比較し一致を
// 確認済み)。フォントが途中で切り替わる文字列を区間ごとに連続して描画するために使う
function _hpPdfAdvance(w,angleDeg){
  const rad=(angleDeg||0)*Math.PI/180;
  return [w*Math.cos(rad), -w*Math.sin(rad)];
}

// V1_183: _collectInto182(配列)を渡すと、個別保存(pdf.save)を行わず
// {fname,blob}をこの配列にpushして終わる「収集モード」で動作する。
// 複数ファイル一括書出(exportHybridPDFBatch183)から使う。理由は下記参照
async function exportHybridPDF(_collectInto182,rangeRect238){
  const btn=document.getElementById('hybridPDFBtn');
  btn.disabled=true;
  if(!_collectInto182) showGuide('HD-PDFを生成中...');
  try{
    // V0_124: 日本語フォントを事前ロード
    await _loadJPFont();

    // ── 1. バウンディングボックス（現行PDFと同じロジック）──
    var _hMnX=Infinity,_hMnY=Infinity,_hMxX=-Infinity,_hMxY=-Infinity;
    function _hExp(x,y){if(!isFinite(x)||!isFinite(y))return;if(x<_hMnX)_hMnX=x;if(y<_hMnY)_hMnY=y;if(x>_hMxX)_hMxX=x;if(y>_hMxY)_hMxY=y;}
    // V2_43: 「範囲指定書出しの線が太すぎる(全体書出と同じ太さにしたい)」との要望
    // により、線幅・手書き太さ・寸法線太さの基準スケールとして「データ全体を用紙に
    // 収めた場合の倍率」が必要になった。そのためrangeRect238の有無に関わらず、
    // 常にデータ全体のバウンディングボックス(_allMnX等)も計算しておく
    var _allMnX=Infinity,_allMnY=Infinity,_allMxX=-Infinity,_allMxY=-Infinity;
    function _allExp(x,y){if(!isFinite(x)||!isFinite(y))return;if(x<_allMnX)_allMnX=x;if(y<_allMnY)_allMnY=y;if(x>_allMxX)_allMxX=x;if(y>_allMxY)_allMxY=y;}
    if(doc){
      for(const e of doc.sen){_allExp(e.x1,e.y1);_allExp(e.x2,e.y2);}
      for(const e of doc.enko){const r=e.rx||e.r||0;_allExp(e.cx-r,e.cy-r);_allExp(e.cx+r,e.cy+r);}
      for(const e of (doc.ten||[])){_allExp(e.x,e.y);}
      for(const e of (doc.moji||[])){_allExp(e.x,e.y);}
      for(const e of (doc.solid||[])){for(const p of e.pts)_allExp(p.x,p.y);}
    }
    if(typeof pdfImage!=='undefined'&&pdfImage){_allExp(pdfImage.wx,pdfImage.wy);_allExp(pdfImage.wx+pdfImage.ww,pdfImage.wy-pdfImage.wh);}
    for(const img of (typeof images!=='undefined'?images:[])){_allExp(img.wx,img.wy);_allExp(img.wx+img.ww,img.wy-img.wh);}
    for(const s of strokes)for(const p of s.pts)_allExp(p.x,p.y);
    for(const d of dims){
      for(const l of(d.lines||[])){_allExp(l.x1,l.y1);_allExp(l.x2,l.y2);}
      if(d.tx!=null&&d.ty!=null)_allExp(d.tx,d.ty);
    }

    // V2_38: 「範囲指定書出」の場合、ユーザーがドラッグで指定した矩形(rangeRect238=
    // {x1,y1,x2,y2}、ワールド座標)をそのままバウンディングボックスとして使う。
    // 「全体書出」は_allMnX等(上で計算したデータ全体の値)をそのまま使うので、
    // 計算結果はV2_42までと完全に同一(数式・走査ロジックは一切変更していない)
    if(rangeRect238){
      _hMnX=rangeRect238.x1; _hMnY=rangeRect238.y1;
      _hMxX=rangeRect238.x2; _hMxY=rangeRect238.y2;
    }else{
      _hMnX=_allMnX; _hMnY=_allMnY; _hMxX=_allMxX; _hMxY=_allMxY;
    }
    if(!isFinite(_hMnX)){showGuide('描画データがありません',2000);return true;} // V1_169: 閉じる連携用(データなし=出力不要なので閉じる処理は継続)

    // ── 2. ページサイズ・スケール決定 ──
    // V1_171: 「周りの余白が多い。四隅のトリムマーク(隅の絵)がギリギリ見える程度まで
    // 余白を減らしたい」との要望により、0.02(2%)→0.005(0.5%)に縮小。
    // 完全に0にすると実際のプリンタの印字不可領域で用紙端が切れるリスクがあるため、
    // 安全な最小限の余白として0.5%を残した
    const PAD=0.005;
    const eW=_hMxX-_hMnX, eH=_hMxY-_hMnY;
    const extMinX=_hMnX-eW*PAD, extMinY=_hMnY-eH*PAD;
    const extW=eW*(1+2*PAD), extH=eH*(1+2*PAD);
    const aspect=extW/extH;
    // V1_153: 「A4版ではなくA3版にして」との要望により、長辺を297mm(A4)→420mm(A3)に変更
    const PDF_LONG_MM=420;

    // V2_43: 線幅・手書き太さ・寸法線太さの基準スケール。「データ全体を用紙(A3長辺
    // 420mm基準)に収めた場合の倍率」を常に使うことで、範囲指定書出でも全体書出と
    // 同じ物理的な太さ(用紙上のmm数)になるようにする。全体書出時はこの値が
    // pdfScale*_sx(通常の実効倍率)と完全に一致するため、_lwScale242を使っても
    // 使わなくても全体書出の結果は変わらない
    let _lwScale242=1;
    if(isFinite(_allMnX)){
      const allEW=_allMxX-_allMnX, allEH=_allMxY-_allMnY;
      const allExtW=allEW*(1+2*PAD), allExtH=allEH*(1+2*PAD);
      const allAspect=allExtW/allExtH;
      _lwScale242 = allAspect>=1 ? PDF_LONG_MM/allExtW : PDF_LONG_MM/allExtH;
    }

    // V2_40修正: _sx/_syはページサイズ決定ブロックの外(このexportHybridPDF関数の
    // 後方、線幅・文字サイズ計算など多数箇所)で参照されるため、if/elseのブロック内で
    // constにすると関数スコープから見えずReferenceErrorになる(全体書出でも発生する
    // 致命的バグだった)。関数トップレベルのvarにして両分岐から代入できるようにした
    var pageMM_W, pageMM_H, pdfScale, w2mx, w2my, _sx=1, _sy=1;
    if(rangeRect238){
      // V2_40: 「範囲指定書出」は用紙を常にA3(297×420mm)固定にする。従来の「全体書出」は
      // 用紙自体を内容のアスペクト比に合わせて可変にしていたが、範囲指定時はユーザーが
      // 選んだ矩形のアスペクト比がまちまちのため、A3固定を望まれた。用紙とコンテンツの
      // アスペクト比が一致しないことがあるので、内容を歪ませず等倍スケールのまま
      // 用紙内に収まる最大サイズで中央配置し、余白ができる形にする(レターボックス)
      const A3_SHORT=297, A3_LONG=420;
      pageMM_W = aspect>=1 ? A3_LONG : A3_SHORT;
      pageMM_H = aspect>=1 ? A3_SHORT : A3_LONG;
      pdfScale = Math.min(pageMM_W/extW, pageMM_H/extH);
      const usedW=extW*pdfScale, usedH=extH*pdfScale;
      const offX=(pageMM_W-usedW)/2, offY=(pageMM_H-usedH)/2;
      w2mx = wx => (wx-extMinX)*pdfScale + offX;
      w2my = wy => pageMM_H - offY - (wy-extMinY)*pdfScale;
    }else{
      pageMM_W=aspect>=1?PDF_LONG_MM:Math.round(PDF_LONG_MM*aspect);
      pageMM_H=aspect>=1?Math.round(PDF_LONG_MM/aspect):PDF_LONG_MM;

      // V1_155: DXF線・円弧・文字・書き込み(手書き・寸法)を全てベクター描画するため、
      // 実際に大きなCanvasを作成する必要が無くなった。LONG_PXは「画面表示相当の
      // 線幅・文字サイズになるようスケール計算するための参照値」としてのみ使用し、
      // メモリ見積り・実測アロケーションテストは不要になったため削除した
      const LONG_PX=6500;
      const CW=aspect>=1?LONG_PX:Math.round(LONG_PX*aspect);
      const CH=aspect>=1?Math.round(LONG_PX/aspect):LONG_PX;
      pdfScale=Math.min(CW/extW, CH/extH);

      // ── 3. 座標変換 ──
      const tx_p = -extMinX * pdfScale;
      const ty_p =  CH + extMinY * pdfScale;
      _sx = pageMM_W / CW;
      _sy = pageMM_H / CH;
      w2mx = wx => ( wx * pdfScale + tx_p) * _sx;
      w2my = wy => (-wy * pdfScale + ty_p) * _sy;
    }

    // ── 5. jsPDF 生成 ──
    if(typeof window.jspdf==='undefined'){showGuide('jsPDFが読み込まれていません',2000);return false;} // V1_169: 閉じる連携用(出力失敗時は閉じない)
    const {jsPDF}=window.jspdf;
    const orient=pageMM_W>=pageMM_H?'l':'p';
    const pdf=new jsPDF({orientation:orient,unit:'mm',format:[pageMM_W,pageMM_H],compress:true});

    // 白背景
    pdf.setFillColor(255,255,255);
    pdf.rect(0,0,pageMM_W,pageMM_H,'F');

    // V2_39: V2_38で追加した「ページ全体でのclip()」処理が原因で、全体書出・
    // 範囲指定書出のどちらもPDFに何も表示されなくなる重大な不具合が発生したため
    // 削除した(jsPDF 2.5.1のclip/discardPathの組み合わせが想定通りに動作せず、
    // 以降の全描画がクリップ領域の外に扱われてしまっていたとみられる)。
    // 「範囲指定書出時、境界をまたぐ線がページ外に少しはみ出て見える可能性がある」
    // という副作用よりも「そもそも何も出力されない」方が重大な問題のため、
    // このクリップ処理自体を撤去し、V2_37以前の(常に正常に表示されていた)
    // 描画方式に戻す。範囲外の見た目の対策は別途、必要であれば要素の事前
    // フィルタリング等、別の安全な方法で検討する。

    // 色設定ヘルパー（e.color は {r,g,b} オブジェクト。白背景用に近白色は黒に変換）
    function _setPdfColor(col){
      const css=(typeof rgbCss==='function')?rgbCss(col,false):'rgb(0,0,0)';
      let r=0,g=0,b=0;
      const m=css.match(/rgb\((\d+),(\d+),(\d+)\)/);
      if(m){r=+m[1];g=+m[2];b=+m[3];}
      else if(css.length>=7&&css[0]==='#'){r=parseInt(css.slice(1,3),16);g=parseInt(css.slice(3,5),16);b=parseInt(css.slice(5,7),16);}
      pdf.setDrawColor(r,g,b);
    }

    // 線幅ヘルパー（現行canvas算出式と同じ: max(0.8, lw*scale*1.4) px → mm変換）
    // V2_43: 範囲指定書出時は、範囲を拡大表示するpdfScaleの代わりに_lwScale242
    // (全体書出相当のスケール)を使い、全体書出と同じ物理的な太さに揃える
    // V2_44: 「DXFの線が異様に太い」バグを修正。下限値0.8は本来「全体書出の
    // 仮想キャンバス(LONG_PX=6500px)上でのpx単位」を意図した値で、全体書出では
    // Math.max(0.8, ...)の後に_sx(px→mm変換, 通常0.06程度)を掛けるため実質約0.05mm
    // 相当になっていた。しかし範囲指定書出(A3固定)は仮想キャンバスを経由せず
    // _sx=1固定のため、0.8がそのまま「0.8mm」という極太の下限として使われて
    // しまっていた(これが「異様に太い」の直接の原因)。範囲指定書出時は、0.8px
    // 相当を全体書出と同じ比率でmmに換算した値(_minLwMM244)を下限として使う
    const _minLwMM244 = 0.8*(PDF_LONG_MM/6500);
    function _lwMM(lw){
      if(rangeRect238){
        return Math.max(0.1, Math.max(_minLwMM244,(lw||0)*_lwScale242*1.4));
      }else{
        return Math.max(0.1, Math.max(0.8,(lw||0)*pdfScale*1.4)*_sx); // 全体書出: 計算式は一切変更していない
      }
    }

    // V1_153: 線種(点線・一点鎖線等)のダッシュパターンをmm単位に変換するヘルパー。
    // 画面描画(viewer.js)は ctx.setLineDash(e.dash.map(d=>d*scale)) で線種を反映して
    // いるが、旧HD-PDF実装(V0_123〜V0_153)にはこの処理が無く、全て実線になっていた
    function _dashMM(dashArr){
      if(!dashArr||dashArr.length===0) return [];
      const sc=rangeRect238?_lwScale242:pdfScale; // V2_43
      return dashArr.map(function(d){ return Math.max(0.05, d*sc*_sx); });
    }

    // V1_170: 手書き（ペン・蛍光ペン）ベクター描画をfilterModeで絞り込めるよう関数化。
    // 'hl'指定時は蛍光ペンのみ、'pen'指定時はペンのみを描画する。
    // 蛍光ペンをDXF線・文字より先に(下に)描画することで、印刷時に黒文字が蛍光の
    // 半透明色で薄く見えてしまう問題を解消する(実際の蛍光ペンのように、先に引いた
    // マークの上へ黒字が重なる見た目にする)。ペンは従来通り文字の後(上)に描画する。
    function _hpDrawStrokes170(filterMode){
      if(typeof strokes==='undefined'||strokes.length===0) return;
      const _curPg155=_curPage();
      const lwRef155=(typeof fitScale!=='undefined'&&fitScale>0)?fitScale:scale;
      for(const s of strokes){
        if(!s.pts||s.pts.length<2) continue;
        if((s.page||1)!==_curPg155) continue;
        if(filterMode==='hl'&&!s.hl) continue;
        if(filterMode==='pen'&&s.hl) continue;
        if(rangeRect238){ // V2_41
          let sMnX=Infinity,sMnY=Infinity,sMxX=-Infinity,sMxY=-Infinity;
          for(const p of s.pts){if(p.x<sMnX)sMnX=p.x;if(p.y<sMnY)sMnY=p.y;if(p.x>sMxX)sMxX=p.x;if(p.y>sMxY)sMxY=p.y;}
          if(!_inRange241(sMnX,sMnY,sMxX,sMxY)) continue;
        }
        const n=s.pts.length;
        const col=s.color||{r:0,g:0,b:0};
        // V1_189: 「HD-PDFの蛍光ペンが画面より細くなる」との指摘により修正。
        // 画面表示(drawAnnotation)ではs.lwに現在の表示ズーム(scale/fitScale比)を掛けて
        // 物理pxの太さを求めるが、PDF書出のベクター座標はscale(=クリック時点の画面ズーム、
        // ユーザーがどこまで拡大して見ていたかで毎回変わる値)ではなく、PDF自身の座標系
        // (図面全体をLONG_PXへ収めるための固定スケールpdfScale)で計算しているため、
        // 太さだけscale基準のままだと現在のズーム状態次第で細くなったり太くなったりして
        // いた。DXF線の太さ(_lwMM)と同じくpdfScale基準に統一する。
        const _strokeSc242=rangeRect238?_lwScale242:pdfScale; // V2_43: 範囲指定書出は全体書出相当スケールで太さを揃える
        const lwPx=s.hl?(s.lw*(_strokeSc242/lwRef155)):Math.max(1,s.lw*(_strokeSc242/lwRef155));
        pdf.setDrawColor(col.r,col.g,col.b);
        pdf.setLineWidth(Math.max(0.05,lwPx*_sx));
        pdf.setLineCap('round'); pdf.setLineJoin('round');
        if(s.hl) pdf.setGState(new pdf.GState({'stroke-opacity':0.45}));
        if(rangeRect238){
          // V2_42: 範囲指定書出時は境界で正確にクリップするため、ベジェ曲線ではなく
          // 隣接する2点ずつを直線分割してクリップ描画する(滑らかさより範囲の
          // 正確さを優先する。全体書出時は下のelse節で従来通りベジェ曲線を描く)
          for(let i=0;i<n-1;i++){
            const cl=_clipLine242(s.pts[i].x,s.pts[i].y,s.pts[i+1].x,s.pts[i+1].y,rangeRect238);
            if(cl) pdf.line(w2mx(cl[0]),w2my(cl[1]),w2mx(cl[2]),w2my(cl[3]));
          }
        }else{
          const P=s.pts.map(p=>[w2mx(p.x),w2my(p.y)]);
          if(n===2){
            pdf.line(P[0][0],P[0][1],P[1][0],P[1][1]);
          }else{
            let curX=(P[0][0]+P[1][0])/2, curY=(P[0][1]+P[1][1])/2;
            const startX=curX, startY=curY;
            const segs=[];
            for(let i=1;i<n-1;i++){
              const Qx=P[i][0], Qy=P[i][1];
              const P2x=(P[i][0]+P[i+1][0])/2, P2y=(P[i][1]+P[i+1][1])/2;
              const C1x=curX+2/3*(Qx-curX), C1y=curY+2/3*(Qy-curY);
              const C2x=P2x+2/3*(Qx-P2x), C2y=P2y+2/3*(Qy-P2y);
              segs.push([C1x-curX,C1y-curY,C2x-curX,C2y-curY,P2x-curX,P2y-curY]);
              curX=P2x; curY=P2y;
            }
            segs.push([P[n-1][0]-curX, P[n-1][1]-curY]);
            pdf.lines(segs,startX,startY,[1,1],'S',false);
          }
        }
        if(s.hl) pdf.setGState(new pdf.GState({'stroke-opacity':1}));
      }
    }

    // V2_41: 「範囲指定書出」時、指定矩形(rangeRect238)と全く重ならない要素は
    // 描画しないようにする(要素単位のフィルタリング)。境界をまたぐ要素は
    // 従来通りそのまま描画される(はみ出て見える可能性はV2_39から許容している方針)。
    // AABB(バウンディングボックス)交差判定のみの簡易版で、線分の一部だけを
    // 切り取るような厳密なクリップは行わない(V2_38のjsPDF clip()導入時に
    // 重大な描画不具合が出た経緯があるため、安全な方法に限定する)。
    function _inRange241(minX,minY,maxX,maxY){
      if(!rangeRect238) return true;
      return minX<=rangeRect238.x2 && maxX>=rangeRect238.x1 && minY<=rangeRect238.y2 && maxY>=rangeRect238.y1;
    }

    // V2_42: 「境界をまたぐ要素は境界内だけ書き出したい」との要望により、線分を
    // 指定矩形(rangeRect238、x1<=x2,y1<=y2前提)で正確に切り取るヘルパーを追加。
    // Liang-Barskyアルゴリズム(標準的な線分クリッピング手法)。完全に範囲外ならnullを
    // 返す。DXF線・円弧(36分割線分近似)・手書き線・寸法線はこれで境界ぴったりに
    // 切り取れるが、文字(DXF文字・寸法値)は行単位でしか描画できず分割不可能なため、
    // 引き続き基準点が範囲内かどうかで全体描画/非描画を判定する(V2_41のまま)。
    function _clipLine242(x1,y1,x2,y2,rect){
      let t0=0, t1=1;
      const dx=x2-x1, dy=y2-y1;
      const p=[-dx, dx, -dy, dy];
      const q=[x1-rect.x1, rect.x2-x1, y1-rect.y1, rect.y2-y1];
      for(let i=0;i<4;i++){
        if(p[i]===0){
          if(q[i]<0) return null;
        }else{
          const r=q[i]/p[i];
          if(p[i]<0){
            if(r>t1) return null;
            if(r>t0) t0=r;
          }else{
            if(r<t0) return null;
            if(r<t1) t1=r;
          }
        }
      }
      return [x1+t0*dx, y1+t0*dy, x1+t1*dx, y1+t1*dy];
    }

    // ── 6. DXF線分（sen）ベクター描画 ──
    if(doc&&doc.sen){
      for(const e of doc.sen){
        if(hiddenLayers.has(e.layer)) continue;
        let lx1=e.x1, ly1=e.y1, lx2=e.x2, ly2=e.y2;
        if(rangeRect238){
          const cl=_clipLine242(lx1,ly1,lx2,ly2,rangeRect238);
          if(!cl) continue;
          lx1=cl[0];ly1=cl[1];lx2=cl[2];ly2=cl[3];
        }
        _setPdfColor(e.color);
        pdf.setLineWidth(_lwMM(e.lw));
        pdf.setLineDashPattern(_dashMM(e.dash),0); // V1_153
        pdf.line(w2mx(lx1),w2my(ly1),w2mx(lx2),w2my(ly2));
      }
    }

    // ── 7. DXF円・円弧（enko）ベクター描画 ──
    if(doc&&doc.enko){
      for(const e of doc.enko){
        if(hiddenLayers.has(e.layer)) continue;
        const r=e.rx||e.r||0; if(r<=0) continue;
        if(!_inRange241(e.cx-r,e.cy-r,e.cx+r,e.cy+r)) continue;
        _setPdfColor(e.color);
        pdf.setLineWidth(_lwMM(e.lw));
        pdf.setLineDashPattern(_dashMM(e.dash),0); // V1_153
        const a1=e.a1!=null?e.a1:0, a2=e.a2!=null?e.a2:360;
        const cxmm=w2mx(e.cx), cymm=w2my(e.cy);
        const rMM=r*pdfScale*_sx;
        if(a1===0&&a2===360&&!rangeRect238){
          // 真円(全体書出時のみ): 従来通りjsPDF circle()。この分岐の計算式は
          // V2_42でも一切変更していない
          pdf.circle(cxmm,cymm,rMM,'S');
        }else{
          // 円弧、または範囲指定書出時の真円: 36分割線分近似（DXF角度: X軸正から反時計回り）
          const rad1=a1*Math.PI/180;
          let rad2=a2*Math.PI/180;
          if(rad2<=rad1) rad2+=2*Math.PI; // 折り返しアーク対応(a1=0,a2=360の場合も自動的にrad2=2πになる)
          const N=36;
          if(rangeRect238){
            // V2_42: 範囲指定書出時は境界で正確にクリップするため、ワールド座標で
            // 各微小線分を計算してからクリップし、その後mm座標へ変換する
            let wx0=e.cx+r*Math.cos(rad1), wy0=e.cy+r*Math.sin(rad1);
            for(let i=1;i<=N;i++){
              const a=rad1+(rad2-rad1)*i/N;
              const wx1=e.cx+r*Math.cos(a), wy1=e.cy+r*Math.sin(a);
              const cl=_clipLine242(wx0,wy0,wx1,wy1,rangeRect238);
              if(cl) pdf.line(w2mx(cl[0]),w2my(cl[1]),w2mx(cl[2]),w2my(cl[3]));
              wx0=wx1; wy0=wy1;
            }
          }else{
            // 全体書出時: 従来通りmm座標で直接計算(計算式は一切変更していない)
            let px0=cxmm+rMM*Math.cos(rad1), py0=cymm-rMM*Math.sin(rad1);
            for(let i=1;i<=N;i++){
              const a=rad1+(rad2-rad1)*i/N;
              const px1=cxmm+rMM*Math.cos(a), py1=cymm-rMM*Math.sin(a);
              pdf.line(px0,py0,px1,py1);
              px0=px1; py0=py1;
            }
          }
        }
      }
    }

    // V1_153: 線分・円弧の描画で設定したダッシュ状態が後続の描画に残らないよう解除
    pdf.setLineDashPattern([],0);

    // ── 7.6 蛍光ペンのみ先行描画（V1_170）──
    // DXF線・文字より先に(下に)描画することで、印刷時に黒文字が蛍光の半透明色で
    // 薄く見えてしまう問題を解消する。ペンは従来通り8.で文字の後(上)に描画する。
    _hpDrawStrokes170('hl');

    // ── 7.5 文字（moji）をjsPDFベクター描画（V0_124: 日本語フォント対応、V1_151: 文字幅補正Phase1）──
    if(doc&&doc.moji&&doc.moji.length>0&&window._notoSansJPBase64){
      try{
        pdf.addFileToVFS('NotoSansJP.ttf',window._notoSansJPBase64);
        pdf.addFont('NotoSansJP.ttf','NotoSansJP','normal');
      }catch(er){/* 登録済みの場合は無視 */}
      for(const e of doc.moji){
        if(hiddenLayers.has(e.layer)) continue;
        if(!e.text||!e.text.trim()) continue;
        if(!_inRange241(e.x,e.y,e.x,e.y)) continue; // V2_41
        const xmm=w2mx(e.x);
        const ymm=w2my(e.y);
        // V1_153: V1_152の「最低6px相当」クランプは、6という数値がCanvas(CW)側の
        // ピクセル単位で、そのCanvas自体がメモリ安全策で数千pxに調整される一方
        // 固定ページ長辺(mm)へ縮小されるため、6px分が最終的に何mmになるかは
        // Canvas解像度に依存してしまい、結果的にほぼ改善しないケースがあった
        // (実際に報告されたPDFでもフォントサイズが変わっていなかった)。
        // 印刷後の見た目のmm寸法で直接下限を決める方式に変更する。
        // V1_158: 「文字がたくさん書いた図面になるとPDFの時に文字が大きくなり
        // すぎてぐちゃぐちゃになる」との指摘を受け、2.2mmから1.1mmへ引き下げ。
        // 実測したところ、A1版・縮尺1/200を想定した密なDXF(部材ラベル約2000個)
        // をA3に収める場合、ほぼ全ての文字(2024個中2001個)が2.2mmの下限に
        // 張り付いて重なり合っていた。この下限は「完全に見えなくなる」ことを
        // 防ぐための安全弁であり、必ずしも快適な可読性まで保証するものではない
        // (図面全体を1枚のA3に収める都合上、密な図面では本来の縮尺より文字が
        // 小さくなるのは避けられない)。下限を約半分に下げることで、密な図面での
        // 重なりを大きく緩和しつつ、完全な不可視化は防ぐバランスを取った
        // V1_159: V1_158(1.1mm)適用後もなお「PDFとアプリの文字の見た目差」が
        // 残っているとの報告(隣接する複数のDXF文字ラベルが密に並ぶ箇所で、
        // フロアによる引き伸ばしが元の行間隔を超えてしまい重なりが残っていた)。
        // PDFはベクター形式でありPDFビューア側で自由に拡大できるため、密な図面では
        // 「フロアで無理に読みやすい大きさへ引き伸ばす」よりも「元の縮尺どおりの
        // 比率を保ち、必要なら閲覧側で拡大してもらう」方が重なりを避けやすいと
        // 判断し、フロアをさらに約半分(1.1mm→0.6mm)に下げた。完全な不可視化(V1_152の実測不具合値は
        // 約0.1mm)を防ぐ安全弁としての役割は0.6mmでも十分に果たせる
        const MIN_TEXT_MM=0.6;
        // V1_166: 「DXFの文字が少し小さい」との指摘により、画面表示(viewer.js)と揃えて
        // HD-PDF書き出しでも文字サイズを1.1倍にした(MOJI_SIZE_MULTIPLIERはviewer.js定義。
        // 未定義環境でも壊れないよう既定値1.1でフォールバックする)
        const _mojiMul166=(typeof MOJI_SIZE_MULTIPLIER!=='undefined')?MOJI_SIZE_MULTIPLIER:1.1;
        const fsMM=Math.max(MIN_TEXT_MM, e.h*pdfScale*_sx*_mojiMul166);
        const fsPx=fsMM/_sx; // 画面実測(measureText)用の対応ピクセルサイズ
        if(fsMM<=0) continue;
        const css=(typeof rgbCss==='function')?rgbCss(e.color,false):'rgb(0,0,0)';
        const mc=css.match(/rgb\((\d+),(\d+),(\d+)\)/);
        if(mc) pdf.setTextColor(+mc[1],+mc[2],+mc[3]);
        pdf.setFontSize(fsMM*(72/25.4));
        // V1_156: 埋め込みフォント未収録の記号(全角チルダ等)を読み飛ばされる前に置換
        const lines=_hpFixChars(e.text).split('\n');
        const angleDeg=(e.angle&&Math.abs(e.angle)>0.1)?e.angle:0;
        for(let i=0;i<lines.length;i++){
          const ln=lines[i];
          if(!ln.trim()) continue;
          // V1_157: ASCII(半角英数字記号)とそれ以外(漢字・かな)でフォントを分けるため
          // 行をランに分割する
          const runs=_hpSplitRuns(ln);
          // V1_151→V1_152→V1_157: 文字幅補正Phase1 — 実際に描画されるサイズ(fsPx、
          // 6px下限適用後)でmeasureTextし、画面実測幅と「各ランを正しいフォントで
          // 実測した合計」との比率をhorizontalScale(PDFのTzオペレータ)として渡す
          var _hpRatio=1;
          try{
            var _pdfMM=0;
            for(const run of runs){ _hpSetRunFont(pdf,run.font); _pdfMM+=pdf.getTextWidth(run.text); }
            if(!_hpMeasureCv){_hpMeasureCv=document.createElement('canvas');_hpMeasureCtx=_hpMeasureCv.getContext('2d');}
            _hpMeasureCtx.font=fsPx+'px sans-serif';
            var _rawPx=_hpMeasureCtx.measureText(ln).width*(e.widthFactor||1);
            if(_rawPx>0&&_pdfMM>0){
              var _screenMM=_rawPx*_sx;
              _hpRatio=_screenMM/_pdfMM;
              if(!isFinite(_hpRatio)||_hpRatio<=0) _hpRatio=1;
              // V1_153: 「文字がやや太い」との指摘を受け、安全域を0.5〜2.0から
              // 0.7〜1.4に狭めた。比率が極端(50%前後など)になるケースで文字が
              // 大きく水平圧縮され、字間が詰まって太く見える一因になっていたため、
              // 補正の効き目を弱める代わりに見た目の歪みを抑える方向にした
              _hpRatio=Math.max(0.7,Math.min(1.4,_hpRatio));
            }
          }catch(werr){_hpRatio=1;}
          // 複数行: PDF座標系（Y下向き）ではi行目をfsMM*i だけ上方向へ(既存仕様のまま)
          let curX=xmm, curY=ymm-fsMM*i;
          for(const run of runs){
            _hpSetRunFont(pdf,run.font);
            const opts={baseline:'alphabetic',horizontalScale:_hpRatio};
            if(angleDeg) opts.angle=angleDeg;
            pdf.text(run.text,curX,curY,opts);
            const rw=pdf.getTextWidth(run.text)*_hpRatio;
            const adv=_hpPdfAdvance(rw,angleDeg);
            curX+=adv[0]; curY+=adv[1];
          }
        }
      }
      pdf.setTextColor(0,0,0); // リセット
    }

    // ── 8. 手書き（strokes）ベクター描画 ──
    // V1_155: 画面描画(drawAnnotation)と同じCatmull-Rom風2次ベジェのスムージングを、
    // jsPDFのpdf.lines()が対応する3次ベジェへ変換して描画する(標準変換式:
    // 現在のペン位置P0・2次制御点Q・終点P2に対しC1=P0+2/3(Q-P0), C2=P2+2/3(Q-P2))。
    // ラスター画像を一切使わないため、V1_152で対応した「巨大画像展開による黒画面」
    // 不具合の要因自体が構造的に無くなる。
    // V1_170: 蛍光ペンは7.6で文字より先に描画済みのため、ここではペンのみ描画する。
    _hpDrawStrokes170('pen');

    // ── 9. 寸法（dims）ベクター描画 ──
    // V1_155: 寸法線・矢印・センターマーク・寸法文字・アンダーバーを全てベクター化。
    // 矢印はctx.translate+rotate(a.angle)と同じ回転行列を自前計算し絶対座標の三角形
    // として塗りつぶす。寸法文字はd.worldFontH(作成時の画面表示ズームに依存しない
    // ワールド座標系での文字高)をDXF文字(doc.moji)と同じ考え方でmm換算し、印刷でも
    // 判読できるよう最低文字高(DIM_MIN_TEXT_MM)を設ける。
    // V1_156: 矢印長・矢印幅・寸法線幅・センターマークは、V1_155では固定mm値だった
    // ため、図面全体をA3用紙に収める縮小率が大きい図面ほど、実寸が小さい寸法
    // (例:実寸2.75mm相当)で矢印同士・矢印と文字が重なって判読できなくなっていた。
    // 画面表示ロジック(dimensionTextMode='fixed'時、矢印長=10*fixedRatio px、
    // fixedRatio=worldFontH*scale/17)と同じ比率関係になるよう、矢印長・矢印幅・
    // 寸法線幅・センターマーク・文字とのオフセットを全てこの寸法の文字サイズ
    // (fsMM、worldFontHに比例)基準の相対値に変更した。これにより文字サイズが
    // 最低文字高(DIM_MIN_TEXT_MM)でクランプされる極小スケールの寸法でも、矢印等が
    // 連動して相応に小さくなり、重なりを避けやすくなる。
    if(typeof dims!=='undefined'&&dims.length>0){
      // V1_158: doc.moji側と同じ理由(密な図面での文字の重なり緩和)により2.2mm→1.1mmへ
      // V1_159: さらに1.1mm→0.6mmへ(doc.moji側と同じ理由・同じ値)
      // V1_160: 「寸法の数字が若干PDFにすると小さくなる」との指摘を受け実測PDFを
      // 解析した結果、寸法値(dims)の文字13個中5個がこの下限(0.6mm)にちょうど
      // 張り付いており、周囲のDXF文字(黒、この図面では自然サイズが約1.4mm相当)や
      // 他の寸法値(自然サイズで0.7〜2.3mm相当)より明らかに小さく浮いて見えていた。
      // dimsは寸法作成時にworldFontHが記録されズーム非依存の一定サイズを意図して
      // いるため、doc.mojiの下限(0.6mm、密な図面での重なり対策)とは別に、dims
      // 専用の下限を引き上げてこの見た目の不揃いを解消する
      const DIM_MIN_TEXT_MM=1.2;
      const _curPg155b=_curPage();
      for(const d of dims){
        if((d.page||1)!==_curPg155b) continue;
        if(rangeRect238){ // V2_41
          let dMnX=Infinity,dMnY=Infinity,dMxX=-Infinity,dMxY=-Infinity;
          for(const l of (d.lines||[])){
            if(l.x1<dMnX)dMnX=l.x1; if(l.y1<dMnY)dMnY=l.y1; if(l.x1>dMxX)dMxX=l.x1; if(l.y1>dMxY)dMxY=l.y1;
            if(l.x2<dMnX)dMnX=l.x2; if(l.y2<dMnY)dMnY=l.y2; if(l.x2>dMxX)dMxX=l.x2; if(l.y2>dMxY)dMxY=l.y2;
          }
          if(d.tx!=null&&d.ty!=null){if(d.tx<dMnX)dMnX=d.tx;if(d.ty<dMnY)dMnY=d.ty;if(d.tx>dMxX)dMxX=d.tx;if(d.ty>dMxY)dMxY=d.ty;}
          if(isFinite(dMnX) && !_inRange241(dMnX,dMnY,dMxX,dMxY)) continue;
        }
        const [dr,dg,db]=_hpHexColor(d.color);
        pdf.setDrawColor(dr,dg,db); pdf.setFillColor(dr,dg,db); pdf.setTextColor(dr,dg,db);
        // V1_156: 画面表示(dimensionTextMode='fixed')の比率(17px基準)をmmへ換算
        const worldH=d.worldFontH||(17/(scale||1));
        const fsMM=Math.max(DIM_MIN_TEXT_MM, worldH*pdfScale*_sx*1.5); // 文字サイズ(表示用、変更なし)
        // V2_43: 「範囲指定書出しの線が太すぎる」との要望により、寸法線・矢印・
        // センターマークの太さ/サイズは、範囲指定書出時のみ全体書出相当の
        // スケール(_lwScale242)を基準にする。文字サイズ(fsMM)・文字との間隔(gapMM)
        // は従来通り拡大表示のまま(全体書出時はlwBaseMM===fsMMとなり計算結果は不変)
        const _dimLwSc242=rangeRect238?_lwScale242:pdfScale;
        const lwBaseMM=Math.max(DIM_MIN_TEXT_MM, worldH*_dimLwSc242*_sx*1.5);
        const lineMM=Math.max(0.05, lwBaseMM/17);
        const arrowLenMM=lwBaseMM*(10/(17*1.5));
        const arrowWMM=lwBaseMM*(4/(17*1.5));
        const gapMM=fsMM*(8/(17*1.5));
        const centerMarkMM=lwBaseMM*(8/(17*1.5));
        pdf.setLineWidth(lineMM);
        pdf.setLineCap('butt'); pdf.setLineJoin('miter');
        for(const l of (d.lines||[])){
          if(rangeRect238){
            // V2_42: 寸法線も境界で正確にクリップする
            const cl=_clipLine242(l.x1,l.y1,l.x2,l.y2,rangeRect238);
            if(cl) pdf.line(w2mx(cl[0]),w2my(cl[1]),w2mx(cl[2]),w2my(cl[3]));
          }else{
            pdf.line(w2mx(l.x1),w2my(l.y1),w2mx(l.x2),w2my(l.y2));
          }
        }
        for(const a of (d.arrows||[])){
          const axmm=w2mx(a.x), aymm=w2my(a.y);
          const p1=_hpRotPt(-arrowLenMM, arrowWMM, a.angle);
          const p2=_hpRotPt(-arrowLenMM,-arrowWMM, a.angle);
          pdf.triangle(axmm,aymm, axmm+p1[0],aymm+p1[1], axmm+p2[0],aymm+p2[1], 'F');
        }
        if(d.text){
          // V1_156: 埋め込みフォント未収録の記号(全角チルダ等)を読み飛ばされる前に置換
          const dtext=_hpFixChars(d.text);
          const txmm=w2mx(d.tx), tymm=w2my(d.ty);
          const angleDeg=-(d.tangle||0)*180/Math.PI; // canvasのctx.rotate(d.tangle)と
                                                       // 同じ見た目になるよう符号反転
          const off=_hpRotPt(0,-gapMM,d.tangle||0);
          if(window._notoSansJPBase64){
            pdf.setFontSize(fsMM*(72/25.4));
            // V1_157: ASCII(半角英数字記号)とそれ以外(漢字・かな)でフォントを分ける
            const runs=_hpSplitRuns(dtext);
            // 中央揃え相当にするため、各ランを正しいフォントで実測した合計幅を求める
            let totalW=0;
            for(const run of runs){ _hpSetRunFont(pdf,run.font); totalW+=pdf.getTextWidth(run.text); }
            const anchorX=txmm+off[0], anchorY=tymm+off[1];
            const startAdv=_hpPdfAdvance(-totalW/2, angleDeg);
            let curX=anchorX+startAdv[0], curY=anchorY+startAdv[1];
            for(const run of runs){
              _hpSetRunFont(pdf,run.font);
              const opts={baseline:'bottom'};
              if(angleDeg) opts.angle=angleDeg;
              pdf.text(run.text,curX,curY,opts);
              const rw=pdf.getTextWidth(run.text);
              const adv=_hpPdfAdvance(rw,angleDeg);
              curX+=adv[0]; curY+=adv[1];
            }
            if(typeof needsUnderbar==='function'&&needsUnderbar(dtext)){
              const twMM=totalW;
              const u1=_hpRotPt(-twMM/2,-gapMM+0.3,d.tangle||0);
              const u2=_hpRotPt( twMM/2,-gapMM+0.3,d.tangle||0);
              pdf.setLineWidth(Math.max(0.1,fsMM*0.07));
              pdf.line(txmm+u1[0],tymm+u1[1], txmm+u2[0],tymm+u2[1]);
              pdf.setLineWidth(lineMM);
            }
          }
        }
        if(d.centerMark){
          const cmxmm=w2mx(d.centerMark.cx), cmymm=w2my(d.centerMark.cy);
          pdf.setLineWidth(lineMM);
          pdf.line(cmxmm-centerMarkMM,cmymm, cmxmm+centerMarkMM,cmymm);
          pdf.line(cmxmm,cmymm-centerMarkMM, cmxmm,cmymm+centerMarkMM);
        }
      }
      pdf.setTextColor(0,0,0); pdf.setFillColor(0,0,0);
    }

    // ── 10. 保存 ──
    // V2_38: 範囲指定書出の場合はファイル名で区別できるようにする
    const fname=(currentFileName||'drawing').replace(/\.[^.]+$/,'')+(rangeRect238?'_hd_範囲':'_hd')+'.pdf';
    if(_collectInto182){
      // V1_183: 収集モード。個別に保存せずBlobを呼び出し元へ渡す
      // (iOS Safari等は1回のユーザー操作につき1回しか保存/共有を許可しないため、
      // 複数ファイルをループ内で毎回pdf.save()すると2件目以降が保存されない問題があった)
      _collectInto182.push({fname:fname, blob:pdf.output('blob')});
      return true;
    }
    pdf.save(fname);
    showGuide('HD-PDFを保存しました',2000);
    return true; // V1_169: 閉じる連携用(出力成功)

  }catch(err){
    console.error('[HybridPDF]',err);
    if(!_collectInto182) showGuide('HD-PDF出力に失敗しました: '+err.message,3000);
    return false; // V1_169: 閉じる連携用(出力失敗時は閉じない、データ消失防止)
  }finally{
    btn.disabled=false;
  }
}
// =========================================================
// V1_190: PDFを開いている時の「HD-PDF書出」— 元PDFのページ自体(ベクター)へ
// ペン・蛍光ペン・寸法をpdf-libで直接ベクター合成する。ユーザーが提供した
// M_Viewer(V7.09)の実装(pdf-lib使用、page.drawSvgPath/drawLine/drawTextで
// 元PDFページに直接重ねる方式)を参考にした。DXFの場合のexportHybridPDF()
// (DXFエンティティを一から再描画する方式)とは別の専用関数。
//
// 【座標系についての重要な前提】
// PDFページを開いている間、strokes/dimsの「ワールド座標」はrenderPdfPage()
// (viewer.js)がpdfImage={wx:0,wy:pageHeightPt,ww:pageWidthPt,wh:pageHeightPt}
// として設定するため、「ワールド座標 = そのページ自身のPDFポイント座標
// (左下原点・Y上向き)」と完全に一致する。よってDXFの場合のような世界→PDF
// 独自スケール(pdfScale)への変換が一切不要で、strokes/dimsの座標をそのまま
// pdf-libの描画座標として使える(sc=1)。
//
// 【ペン・蛍光ペンの太さについて】
// V1_189でDXFのHD-PDF書出について「太さがクリック時点の画面ズームscaleに
// 依存してしまう」不具合を修正したが、その時の対策(pdfScale基準に統一)は
// 「PDF出力用に一度だけ計算される固定スケール」がある場合の解法だった。
// PDFページのHD-PDF書出では、ワールド座標が既にページ自身のポイント座標と
// 一致している(=出力先の物理単位がそもそも固定)ため、同種の対策として
// 「現在の画面ズームscale」ではなく「現在のfitScale(画面にページ全体が
// ぴったり収まるズーム)」を基準に太さを計算する。fitScaleは表示ウィンドウの
// 大きさ(画面回転等)に依存するため厳密には完全固定ではないが、少なくとも
// 「たまたまその瞬間どれだけ拡大して見ていたか」には左右されなくなる。
async function exportPdfMergedHybrid190(pageNums){
  if(typeof PDFLib==='undefined'){showGuide('pdf-libが読み込まれていません',2000);return false;}
  var origBuf190=(typeof openFilesBufs!=='undefined'&&typeof currentFileIdx!=='undefined'&&currentFileIdx>=0)?openFilesBufs[currentFileIdx]:null;
  if(!origBuf190){showGuide('元のPDFデータが見つかりません',2000);return false;}
  if(!pageNums||!pageNums.length){showGuide('ページが指定されていません',2000);return false;}
  var btn190=document.getElementById('hybridPDFBtn');
  if(btn190) btn190.disabled=true;
  showGuide('HD-PDFを生成中...');
  try{
    var PDFDocument190=PDFLib.PDFDocument, rgb190=PDFLib.rgb, degrees190=PDFLib.degrees, LineCapStyle190=PDFLib.LineCapStyle;
    var srcDoc190=await PDFDocument190.load(origBuf190.slice(0),{ignoreEncryption:true});
    var outDoc190=await PDFDocument190.create();
    if(typeof fontkit!=='undefined') outDoc190.registerFontkit(fontkit);
    var jpFont190=null;
    if(window._notoSansJPBase64){
      try{
        var fontBytes190=Uint8Array.from(atob(window._notoSansJPBase64),function(c){return c.charCodeAt(0);});
        jpFont190=await outDoc190.embedFont(fontBytes190,{subset:true});
      }catch(fe190){ console.warn('[PDF merge] JPフォント埋込失敗',fe190); }
    }
    var fitRef190=(typeof fitScale!=='undefined'&&fitScale>0)?fitScale:(scale||1);
    var srcPageCount190=srcDoc190.getPageCount();
    var okCount190=0, failedPages190=[];
    for(var pi190=0;pi190<pageNums.length;pi190++){
      var pg190=pageNums[pi190];
      if(pg190<1||pg190>srcPageCount190) continue;
      if(pageNums.length>1) showGuide('HD-PDF生成中 ('+(pi190+1)+'/'+pageNums.length+')ページ'+pg190,1500);
      try{
        var copied190=(await outDoc190.copyPages(srcDoc190,[pg190-1]))[0];
        outDoc190.addPage(copied190);
        var pageH190=copied190.getSize().height;
        // V1_196: ページに/Rotate(90/180/270)が付いている場合、書込み座標(表示上の
        // 回転済みフレーム=world)とpdf-lib描画先(常に回転前の生PDF座標系)がずれて
        // 書込みが回転して見えるバグの修正。pdf.jsのconvertToPdfPointで正しく変換する
        var pdfPage190=await pdfDoc.getPage(pg190);
        var vp190=pdfPage190.getViewport({scale:1});
        var mapper190=_hpMakeRawMapper196(vp190);
        var pgStrokes190=(typeof strokes!=='undefined'?strokes:[]).filter(function(s){return (s.page||1)===pg190;});
        var pgDims190=(typeof dims!=='undefined'?dims:[]).filter(function(d){return (d.page||1)===pg190;});
        // 蛍光ペン(下)→寸法(中)→ペン(上)の順で重ねる(exportHybridPDFの重ね順に倣う)
        _hpDrawStrokesPdfLib190(copied190,pgStrokes190,'hl',fitRef190,pageH190,rgb190,LineCapStyle190,mapper190);
        _hpDrawDimsPdfLib190(copied190,pgDims190,jpFont190,rgb190,degrees190,pageH190,mapper190);
        _hpDrawStrokesPdfLib190(copied190,pgStrokes190,'pen',fitRef190,pageH190,rgb190,LineCapStyle190,mapper190);
        okCount190++;
      }catch(pe190){
        console.error('[PDF merge] page='+pg190,pe190);
        failedPages190.push(pg190);
      }
    }
    if(okCount190===0){
      showGuide('出力できるページがありませんでした',2500);
      return false;
    }
    var bytes190=await outDoc190.save();
    var blob190=new Blob([bytes190],{type:'application/pdf'});
    var fname190=(currentFileName||'drawing').replace(/\.[^.]+$/,'')+'_hd.pdf';
    await _saveBlobWithFallback183(blob190,fname190,'PDF (書込み・寸法付き)');
    showGuide(failedPages190.length?('HD-PDFを保存しました(失敗ページ:'+failedPages190.join(',')+')'):'HD-PDFを保存しました',2500);
    return true;
  }catch(e190){
    console.error('[PDF merge]',e190);
    showGuide('HD-PDF出力に失敗しました: '+e190.message,3000);
    return false;
  }finally{
    if(btn190) btn190.disabled=false;
  }
}

// V1_190: M_Viewer(参考実装)のCatmull-Rom→3次ベジェSVGパス変換を移植。
// pts:[{x,y},...] ワールド座標(=出力先PDFページのポイント座標そのもの)、
// h:出力ページの高さ(pt)。pdf-libのdrawSvgPathはSVG流儀(Y下向き)のパスを
// そのまま解釈するため、Y座標をh-yで反転してから渡す(drawSvgPath呼び出し時に
// x:0,y:hを原点オフセットとして指定する組み合わせで、通常のPDF座標(Y上向き)の
// 点を正しい位置に描画できる。M_Viewer実装と同じ手法)
function _buildSmoothSvgPath190(pts,h){
  if(!pts||pts.length<2) return null;
  var MIN_D2=0.01; // 0.1pt^2未満の移動は重複とみなして除去
  var raw=[];
  for(var i=0;i<pts.length;i++){
    var x=pts[i].x, y=h-pts[i].y;
    if(!isFinite(x)||!isFinite(y)) continue;
    if(raw.length>0){
      var prev=raw[raw.length-1];
      var dx=x-prev.x, dy=y-prev.y;
      if(dx*dx+dy*dy<MIN_D2) continue;
    }
    raw.push({x:+x.toFixed(3),y:+y.toFixed(3)});
  }
  if(raw.length<2) return null;
  if(raw.length===2) return 'M'+raw[0].x+' '+raw[0].y+' L'+raw[1].x+' '+raw[1].y;
  var d='M'+raw[0].x+' '+raw[0].y+' ';
  for(var i=0;i<raw.length-1;i++){
    var p0=raw[Math.max(0,i-1)],p1=raw[i],p2=raw[i+1],p3=raw[Math.min(raw.length-1,i+2)];
    var cp1x=+(p1.x+(p2.x-p0.x)/6).toFixed(3), cp1y=+(p1.y+(p2.y-p0.y)/6).toFixed(3);
    var cp2x=+(p2.x-(p3.x-p1.x)/6).toFixed(3), cp2y=+(p2.y-(p3.y-p1.y)/6).toFixed(3);
    d+='C'+cp1x+' '+cp1y+' '+cp2x+' '+cp2y+' '+p2.x+' '+p2.y+' ';
  }
  return d.trim();
}

// V1_196: ページの/Rotate(90/180/270度)による座標系のずれを補正するマッパーを
// 生成する。vp=pdfPage.getViewport({scale:1})(表示中の回転済みビジュアルフレーム)。
// 本アプリの「ワールド座標」はY上向き(w2s系)だが、pdf.jsのconvertToPdfPointは
// Y下向きのビューポート座標を期待するため、まずY反転してから変換する。戻り値の
// pt(wx,wy)はpdf-lib描画にそのまま使える生PDF座標(Y上向き)。angleDeltaDegは
// 「ワールド上の角度」を「生PDF座標上の角度」に直すための加算量(度)。
function _hpMakeRawMapper196(vp){
  function pt(wx,wy){
    var p=vp.convertToPdfPoint(wx, vp.height-wy);
    return {x:p[0], y:p[1]};
  }
  var p0=pt(0,0), p1=pt(1,0);
  var angleDeltaDeg=Math.atan2(p1.y-p0.y, p1.x-p0.x)*180/Math.PI;
  return {pt:pt, angleDeltaDeg:angleDeltaDeg};
}

// V1_190: ペン・蛍光ペン(strokes)をpdf-libで元PDFページへ直接ベクター描画する。
// 太さはfitRef(現在のfitScale)基準(前掲コメント参照)。DXF向け_hpDrawStrokes170
// と役割は同じだが、pdfScale/w2mx/w2my変換が不要(ワールド座標=出力ページ座標)なため
// 別関数として実装している
// V1_196: mapper引数を追加。ページ回転がある場合、各点をワールド座標→生PDF座標へ
// 変換してから描画することで、書込みが回転してずれるバグを修正した
function _hpDrawStrokesPdfLib190(page,pgStrokes,filterMode,fitRef,pageH,rgbFn,LineCapStyle,mapper){
  for(var i=0;i<pgStrokes.length;i++){
    var s=pgStrokes[i];
    if(!s.pts||s.pts.length<2) continue;
    if(filterMode==='hl'&&!s.hl) continue;
    if(filterMode==='pen'&&s.hl) continue;
    var col=s.color||{r:0,g:0,b:0};
    var lwPt=Math.max(0.1, (s.hl?s.lw:Math.max(1,s.lw)) / fitRef);
    var rawPts196=mapper?s.pts.map(function(p){return mapper.pt(p.x,p.y);}):s.pts;
    var svgPath=_buildSmoothSvgPath190(rawPts196,pageH);
    if(!svgPath) continue;
    try{
      page.drawSvgPath(svgPath,{
        x:0,y:pageH,
        borderColor:rgbFn(col.r/255,col.g/255,col.b/255),
        borderWidth:lwPt,
        borderOpacity:s.hl?0.45:1,
        borderLineCap:LineCapStyle?LineCapStyle.Round:undefined
      });
    }catch(se190){ console.warn('[PDF merge] stroke draw fail',se190); }
  }
}

// V1_190: 寸法(dims)をpdf-libで元PDFページへ直接ベクター描画する。既存の
// DXF向け寸法描画(exportHybridPDF内、9.節)と同じ比率定数(矢印長10/17、
// 矢印幅4/17、離れ8/17、芯マーク8/17、線幅fs/17)を、mm単位からpt単位へ
// そのまま読み替えて使用している(ワールド座標=出力ページのpt座標のため、
// pdfScale/_sxによる単位変換が不要になった分だけDXF向けよりシンプル)。
// 日本語フォントはNotoSansJPひとつを埋め込んで使うため、DXF向けのような
// ASCII/日本語のフォント使い分け(_hpSplitRuns等)は行わず単純に中央揃えする
// V1_196: mapper引数を追加。すべての座標(線・矢印・文字位置・中心マーク)は
// 「ワールド座標で絶対位置を計算し切ってから、最後にmapper.ptで生PDF座標へ
// 変換する」方針で統一している(ローカルオフセットのベクトル自体はワールド座標系
// のまま_hpRotPt等で計算してよい。回転していると混同しやすいのは、オフセット
// 加算前の"中心点だけ"を変換して後からオフセットを足すような書き方で、90度/270度
// 回転時はワールドのX方向と生PDF側のX方向が一致しないため、それをやると軸が
// ずれる。必ず絶対座標を確定させた後に1点ずつ変換すること)。
// 文字の回転角(drawTextのrotate)はmapper.angleDeltaDegを加算して補正する
// (位置と違い、角度パラメータはpdf-lib内部でその生PDF座標系上の回転として
// 直接使われるため、mapper.ptでは補正できないことに注意)
function _hpDrawDimsPdfLib190(page,pgDims,jpFont,rgbFn,degreesFn,pageH,mapper){
  var DIM_MIN_TEXT_PT=1.2*72/25.4; // 旧DIM_MIN_TEXT_MM(1.2mm)のpt換算
  function P196(x,y){ return mapper?mapper.pt(x,y):{x:x,y:y}; }
  var angleDelta196=mapper?mapper.angleDeltaDeg:0;
  for(var i=0;i<pgDims.length;i++){
    var d=pgDims[i];
    var colArr=_hpHexColor(d.color);
    var pdfCol=rgbFn(colArr[0]/255,colArr[1]/255,colArr[2]/255);
    var worldH=d.worldFontH||(17/((typeof scale!=='undefined'&&scale)?scale:1));
    var fsPt=Math.max(DIM_MIN_TEXT_PT, worldH*1.5);
    var linePt=Math.max(0.1, fsPt/17);
    var arrowLenPt=fsPt*(10/(17*1.5));
    var arrowWPt=fsPt*(4/(17*1.5));
    var gapPt=fsPt*(8/(17*1.5));
    var centerMarkPt=fsPt*(8/(17*1.5));
    (d.lines||[]).forEach(function(l){
      var p1=P196(l.x1,l.y1), p2=P196(l.x2,l.y2);
      try{ page.drawLine({start:p1,end:p2,thickness:linePt,color:pdfCol}); }catch(le190){}
    });
    (d.arrows||[]).forEach(function(a){
      var o1=_hpRotPt(-arrowLenPt,arrowWPt,a.angle);
      var o2=_hpRotPt(-arrowLenPt,-arrowWPt,a.angle);
      // 3頂点はワールド絶対座標を確定させてから個別に変換する
      var q0=P196(a.x,a.y), q1=P196(a.x+o1[0],a.y+o1[1]), q2=P196(a.x+o2[0],a.y+o2[1]);
      var tx0=q0.x, ty0=pageH-q0.y;
      var tx1=q1.x, ty1=pageH-q1.y;
      var tx2=q2.x, ty2=pageH-q2.y;
      var path='M'+tx0.toFixed(3)+' '+ty0.toFixed(3)+' L'+tx1.toFixed(3)+' '+ty1.toFixed(3)+' L'+tx2.toFixed(3)+' '+ty2.toFixed(3)+' Z';
      try{ page.drawSvgPath(path,{x:0,y:pageH,color:pdfCol}); }catch(ae190){}
    });
    if(d.text&&jpFont){
      var dtext=_hpFixChars(d.text);
      var angleDeg=-(d.tangle||0)*180/Math.PI;
      var off=_hpRotPt(0,-gapPt,d.tangle||0);
      var totalW=0;
      try{ totalW=jpFont.widthOfTextAtSize(dtext,fsPt); }catch(we190){}
      var anchorX=d.tx+off[0], anchorY=d.ty+off[1];
      var startAdv=_hpPdfAdvance(-totalW/2,angleDeg);
      var drawXW=anchorX+startAdv[0], drawYW=anchorY+startAdv[1]; // ワールド絶対座標
      var qd=P196(drawXW,drawYW);
      try{
        page.drawText(dtext,{x:qd.x,y:qd.y,size:fsPt,font:jpFont,color:pdfCol,rotate:degreesFn(angleDeg+angleDelta196)});
      }catch(txe190){ console.warn('[PDF merge] text draw fail',txe190); }
      if(typeof needsUnderbar==='function'&&needsUnderbar(dtext)){
        var ubOff=0.3*72/25.4; // 旧+0.3mmのpt換算
        var u1=_hpRotPt(-totalW/2,-gapPt+ubOff,d.tangle||0);
        var u2=_hpRotPt(totalW/2,-gapPt+ubOff,d.tangle||0);
        var uq1=P196(d.tx+u1[0],d.ty+u1[1]), uq2=P196(d.tx+u2[0],d.ty+u2[1]);
        try{
          page.drawLine({start:uq1,end:uq2,thickness:Math.max(0.1,fsPt*0.07),color:pdfCol});
        }catch(ue190){}
      }
    }
    if(d.centerMark){
      var cx190=d.centerMark.cx, cy190=d.centerMark.cy;
      // 十字の4端点はワールド絶対座標を確定させてから個別に変換する
      var cL=P196(cx190-centerMarkPt,cy190), cR=P196(cx190+centerMarkPt,cy190);
      var cB=P196(cx190,cy190-centerMarkPt), cT=P196(cx190,cy190+centerMarkPt);
      try{
        page.drawLine({start:cL,end:cR,thickness:linePt,color:pdfCol});
        page.drawLine({start:cB,end:cT,thickness:linePt,color:pdfCol});
      }catch(cme190){}
    }
  }
}

// V1_188: V1_183でexportHybridPDF()に_collectInto182(バッチ収集用配列)引数を
// 追加した際、このリスナー登録を直接参照(exportHybridPDF)のままにしていたため、
// クリック時にブラウザが自動で渡すMouseEventオブジェクトが_collectInto182として
// 渡ってしまい、真の引数無し呼び出しのつもりが常にバッチモードと誤認識される
// バグがあった(Event.pushが無く内部でエラーになり、かつエラー時のガイド表示も
// 「バッチモード中は個別ガイドを出さない」分岐によって抑制されるため、ボタンが
// 「反応しない」ように見えていた)。無名関数でラップし引数を渡さないよう修正。
// V1_190: PDFを開いている場合は、元PDF+書込み・寸法を合体するページ選択付きの
// 専用フロー(exportPdfMergedHybrid190)を使う。DXF等それ以外は従来通り
// exportHybridPDF()を呼ぶ(挙動は一切変更していない)
document.getElementById('hybridPDFBtn').addEventListener('click',function(){
  if(typeof pdfDoc!=='undefined'&&pdfDoc){
    if(typeof _showPdfHdExportPageDialog190==='function'){
      _showPdfHdExportPageDialog190(document.getElementById('hybridPDFBtn'),function(pages){
        exportPdfMergedHybrid190(pages);
      });
    } else {
      showGuide('ページ選択機能が読み込まれていません',2000);
    }
    return;
  }
  // V2_38: DXFの場合、「全体書出」か「範囲指定書出」かを選べるようにする。
  // ダイアログ関数が無い場合は従来通り全体書出のみ行う(フォールバック、既存動作維持)
  if(typeof _showHdPdfScopeDialog238==='function'){
    _showHdPdfScopeDialog238(document.getElementById('hybridPDFBtn'),function(scope){
      if(scope==='range'){
        if(!doc&&!(typeof pdfImage!=='undefined'&&pdfImage)){showGuide('図面がありません',1500);return;}
        if(typeof resetToolStates==='function') resetToolStates();
        if(typeof resetSW==='function') resetSW();
        if(window.SW){
          window.SW.active=true;
          window.SW.purpose='hdpdf';
        }
        document.querySelectorAll('.tool-btn').forEach(function(b){b.classList.remove('active');});
        showGuide('HD-PDF範囲指定：出力したい範囲を対角にドラッグしてください',0);
      } else {
        exportHybridPDF();
      }
    });
  } else {
    exportHybridPDF();
  }
});
