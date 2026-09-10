// storage.js — ローカルストレージ保存・復元
// DXF Viewer V0_116
// 依存グローバル: strokes, dims, savedViews (var), tx, ty, scale, bwMode, currentFileName (viewer.js)
//               hiddenLayers (layer.js)
//               currentTool, currentColor, currentLW (var, HTML inline script)
//               openFiles, openFilesBufs, currentFileIdx (HTML inline script)
// 依存関数: loadPDF, parseDXF, detectScale, updateFileNameDisplay, scheduleDraw, scheduleOverlay (viewer.js)
//           buildLayerModal (layer.js)
//           updateViewmemoState (ui.js)
//           updateUndoRedo (HTML inline script)
//           saveCurrentFileState, updateFileNavUI (HTML inline script)

const SAVE_KEY='dxfview_v1';
const FILE_KEY='dxfview_v1_file';
const MULTI_KEY='dxfview_v1_multi'; // V0_112: マルチファイル復元用
let saveTimer=null;
let _bkTimer=null;   // V0_121: バックアップタイマー
let _bkLastTs=0;     // V0_121: 最後のバックアップ時刻(ms)

// =========================================================
// V0_114: IndexedDB（復元用バイナリ専用）
// 既存 dxfViewerDB(dxfIndex) とは完全に別DB — バージョン競合なし
// =========================================================
const _LS_IDB_NAME='dxfViewerFilesDB';
const _LS_IDB_VER=1;
const _LS_IDB_STORE='dxfFiles';

// V2_46: doSave()のたび（約800msデバウンスで高頻度）に呼ばれるが、従来は毎回
// indexedDB.open()で新規接続を開き、一度もclose()していなかった。_dvAutoSave()で
// 実際にクラッシュを引き起こしたのと同じ「未クローズ接続が溜まる」パターンのため、
// _dvOpenIdb()と同じ対策（接続キャッシュ＋onclose検知による自動再接続）を適用した
var _lsIdbConn=null;
function _lsIdbOpen(cb){
  if(_lsIdbConn){cb(null,_lsIdbConn);return;}
  var req=indexedDB.open(_LS_IDB_NAME,_LS_IDB_VER);
  req.onupgradeneeded=function(e){
    var db=e.target.result;
    // dxfFilesストアのみ作成。dxfViewerDB/dxfIndexには一切触れない。
    if(!db.objectStoreNames.contains(_LS_IDB_STORE))
      db.createObjectStore(_LS_IDB_STORE,{keyPath:'name'});
  };
  req.onsuccess=function(e){
    _lsIdbConn=e.target.result;
    _lsIdbConn.onclose=function(){_lsIdbConn=null;};
    cb(null,_lsIdbConn);
  };
  req.onerror=function(e){cb(e.target.error,null);};
}

// ArrayBufferをname(ファイル名)をキーとして保存
function _lsIdbPut(name,buf){
  _lsIdbOpen(function(err,db){
    if(err)return;
    var tx=db.transaction(_LS_IDB_STORE,'readwrite');
    tx.objectStore(_LS_IDB_STORE).put({name:name,buf:buf,ts:Date.now()});
  });
}

// V2_24: ファイル本体(dxfFiles)を明示的に削除する。タブを閉じた時の自動削除
// (index.htmlのdoCloseTab)、設定パネルの一括削除機能から使う独立した追加関数。
// 既存のput/get処理(自動保存・復元)には一切影響しない
function _lsIdbDelete(name,cb){
  _lsIdbOpen(function(err,db){
    if(err){ if(cb)cb(err); return; }
    try{
      var tx=db.transaction(_LS_IDB_STORE,'readwrite');
      tx.objectStore(_LS_IDB_STORE).delete(name);
      tx.oncomplete=function(){ if(cb)cb(null); };
      tx.onerror=function(e){ if(cb)cb(e.target.error); };
    }catch(e){ if(cb)cb(e); }
  });
}

// IDB優先→localStorageフォールバック。cb(ArrayBuffer|null)
function _lsIdbGet(name,lsKey,cb){
  _lsIdbOpen(function(err,db){
    if(err){_lsFromStorage(lsKey,cb);return;}
    var tx=db.transaction(_LS_IDB_STORE,'readonly');
    var req=tx.objectStore(_LS_IDB_STORE).get(name);
    req.onsuccess=function(e){
      if(e.target.result&&e.target.result.buf){cb(e.target.result.buf);}
      else{_lsFromStorage(lsKey,cb);}
    };
    req.onerror=function(){_lsFromStorage(lsKey,cb);};
  });
}

// localStorageのbase64バイナリをArrayBufferに変換して返す（旧データ互換）
function _lsFromStorage(lsKey,cb){
  try{
    var fr=localStorage.getItem(lsKey);
    if(!fr){cb(null);return;}
    var obj=JSON.parse(fr);
    if(!obj.b64){cb(null);return;}
    var bin=atob(obj.b64);
    var buf=new ArrayBuffer(bin.length);
    var arr=new Uint8Array(buf);
    for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    cb(buf);
  }catch(e){cb(null);}
}

// Promise版（tryRestore内でawait用）
function _lsIdbGetP(name,lsKey){
  return new Promise(function(resolve){_lsIdbGet(name,lsKey,resolve);});
}

// =========================================================
// 自動保存スケジュール
// =========================================================
function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(doSave,800);if(typeof verify==='function')verify('scheduleSave');}

// =========================================================
// localStorage へ保存（DXFバイナリはIndexedDBへ）
// =========================================================
function doSave(){
  // V2_17: 複数/単一ファイルオープン処理中(_isOpeningFileBusy)は、currentFileIdxと
  // currentFileNameが一時的に食い違う瞬間があるため、doSave()を実行するとタブへの
  // 誤書込みが起こりうる(V2_06で対策したscheduleSave()のno-op化はscheduleSave経由の
  // 呼び出ししか防げず、visibilitychange/pagehide/beforeunloadがdoSave()を直接
  // 呼ぶ経路や、単一ファイルオープン中に既存タイマーが発火する経路は未対策だった)。
  // ファイルオープン処理中は保存自体を1回スキップし、完了後にscheduleSave()が
  // 改めて呼ばれることで最終状態を正しく保存する(既存のV2_06対策と矛盾しない)
  if(typeof _isOpeningFileBusy!=='undefined'&&_isOpeningFileBusy){
    if(typeof verify==='function')verify('doSave:skipped(opening)');
    return;
  }
  if(typeof verify==='function')verify('doSave:start');
  try{
    // V0_140: saveCurrentFileState廃止 — openFiles[]は常に最新（参照エイリアス）
    // ビュー状態（tx/ty/scale/hiddenLayersArr）のみ現在ファイルに同期する
    if(typeof openFiles!=='undefined'&&currentFileIdx>=0&&currentFileIdx<openFiles.length){
      var _cfsv=openFiles[currentFileIdx];
      _cfsv.tx=tx;_cfsv.ty=ty;_cfsv.scale=scale;_cfsv.fitScale=fitScale;
      _cfsv.hiddenLayersArr=Array.from(hiddenLayers);
      var _pnSv=1;try{if(typeof pdfPageNum!=='undefined')_pnSv=pdfPageNum;}catch(e){}
      _cfsv.pdfPageNum=_pnSv;
      _cfsv.currentFileName=currentFileName;_cfsv.fileSize=currentFileSize;
      if(typeof _diSyncStateToFile==='function') _diSyncStateToFile(); // V1_162: 図面番号欄インセットの状態も同期
    }
    const sd=parseFloat(document.getElementById('scaleDenom').value)||1;
    const _insetSv162=(typeof currentFileIdx!=='undefined'&&currentFileIdx>=0&&openFiles[currentFileIdx])?(openFiles[currentFileIdx].insetState||null):null;
    localStorage.setItem(SAVE_KEY,JSON.stringify({
      strokes,dims,savedViews,tx,ty,scale,fitScale,
      bwMode,scaleDenom:sd,hiddenLayers:[...hiddenLayers],
      currentTool,currentColor,currentLW,currentFileName,fileSize:currentFileSize,
      fileKey:(typeof _fileKey==='function'?_fileKey(currentFileName,currentFileSize):null),
      currentHL_Color,currentHL_LW,currentDimColor,
      ERASER_RADIUS_PX:(typeof ERASER_RADIUS_PX!=='undefined'?ERASER_RADIUS_PX:20), // V1_207: 消しゴム範囲を保存
      _lastMeasureTool:(typeof _lastMeasureTool!=='undefined'?_lastMeasureTool:null), // V1_210: 前回選んだ計測ツールを保存
      dimensionTextMode,inputMode, // V0_154: dimTextManualPxは「サイズ指定」廃止に伴い削除
      pdfPageNum:(typeof pdfPageNum!=='undefined'?pdfPageNum:1), // V0_135: PDFページ番号保存
      insetState:_insetSv162 // V1_162: 図面番号欄インセットの位置・倍率・表示ON/OFF
    }));
    // V0_112: マルチファイル保存
    if(typeof openFiles!=='undefined'&&openFiles.length>1&&typeof openFilesBufs!=='undefined'){
      var _mStates=openFiles.map(function(f){
        return {
          name:f.name,currentFileName:f.currentFileName,fileKey:f.fileKey||null,
          strokes:f.strokes||[],dims:f.dims||[],
          savedViews:f.savedViews||[null,null,null,null,null],
          hiddenLayersArr:f.hiddenLayersArr||[],
          tx:f.tx||0,ty:f.ty||0,scale:f.scale||1,fitScale:f.fitScale||1,
          fileSize:f.fileSize||0,scaleDenom:sd,
          isPDF:!!(f.pdfDoc||f.pdfImage),
          isExcel:!!f.excelWb, excelSheetIdx:f.excelSheetIdx||0, // V1_76
          pdfPageNum:f.pdfPageNum||1, // V0_135: PDFページ番号保存
          insetState:f.insetState||null // V1_162: 図面番号欄インセットの位置・倍率・表示ON/OFF
        };
      });
      // V0_114: DXFバイナリはIndexedDBへ保存（サイズ制限・容量制限なし）
      for(var _i=0;_i<openFiles.length;_i++){
        var _buf=openFilesBufs[_i];
        var _fname=openFiles[_i].fileKey||openFiles[_i].currentFileName||openFiles[_i].name; // V0_116: fileKey優先
        if(_buf&&_fname)_lsIdbPut(_fname,_buf);
      }
      try{
        localStorage.setItem(MULTI_KEY,JSON.stringify({
          count:openFiles.length,
          currentFileIdx:currentFileIdx,
          files:_mStates
        }));
      }catch(e2){localStorage.removeItem(MULTI_KEY);}
    }else{
      localStorage.removeItem(MULTI_KEY);
    }
    if(typeof verify==='function')verify('doSave:done');
    scheduleBkSave(); // V0_121: クールダウン方式バックアップをスケジュール
    _dvAutoSave(); // V0_127: .dxfview自動保存
    // V1_01: Supabaseへも現在ファイルの注記(strokes/dims)を自動保存（非同期・失敗しても無視）
    if(typeof _sbPushCurrentAnnotations==='function'){try{_sbPushCurrentAnnotations();}catch(e){}}
  }catch(e){if(typeof verifyWarn==='function')verifyWarn('localStorage保存失敗');}
}

// =========================================================
// ファイルを IndexedDB へ保存（V0_114: localStorageから移行）
// =========================================================
function saveFile(buf,name){
  if(!buf||!name)return;
  if(typeof verify==='function')verify('saveFile',{name:name});
  _lsIdbPut(name,buf); // V0_114: IDBのみ保存（サイズ・容量制限なし）
}

// =========================================================
// ページ読み込み時の復元
// =========================================================
async function tryRestore(){
  if(typeof verify==='function')verify('tryRestore:start');

  // ── V0_112: マルチファイル復元 ──────────────────────────────
  var _multiOk=false;
  try{
    const _mr=localStorage.getItem(MULTI_KEY);
    if(_mr){
      const _md=JSON.parse(_mr);
      if(_md.files&&_md.files.length>1){
        var _restored=[];
        var _rbufs=[];
        var _activeLocal=-1;
        for(var _i=0;_i<_md.files.length;_i++){
          var _mf=_md.files[_i];
          var _fname=_mf.fileKey||_mf.currentFileName||_mf.name; // V0_116: fileKey優先（後方互換fallback付き）
          // V0_114: IDB優先→localStorageフォールバック
          var _buf2=await _lsIdbGetP(_fname,FILE_KEY+'_'+_i);
          if(!_buf2) continue;
          // V1_55: 従来はPDFタブを無条件でcontinueして復元対象から除外していたため、
          // DXFと一緒にPDFタブを開いていた場合、アプリを閉じて再度開くとPDFタブだけ
          // 消えてしまう不具合があった。pdfjsLib.getDocument()でpdfDocを再構築し、
          // 保存されていたページを再描画してpdfImageも復元するようにした
          if(_mf.isPDF){
            try{
              if(typeof pdfjsLib==='undefined') continue;
              var _pnR=_mf.pdfPageNum||1;
              var _pdocR=await pdfjsLib.getDocument({data:_buf2.slice(0)}).promise; // V1_52同様、bufをdetachさせないようコピーを渡す
              var _pageR=await _pdocR.getPage(_pnR);
              // V1_85: 基準解像度を固定3からPDF_BASE_SCALE(既定4)へ。メイン画面のrenderPdfPage()と
              // 同じ基準に揃える（このタブはアクティブになった時にswitchToFile側で改めて
              // 表示範囲に応じた高解像度化の対象になる）
              var _vpR=_pageR.getViewport({scale:(typeof PDF_BASE_SCALE!=='undefined'?PDF_BASE_SCALE:4)});
              var _offR=document.createElement('canvas');
              _offR.width=_vpR.width;_offR.height=_vpR.height;
              await _pageR.render({canvasContext:_offR.getContext('2d'),viewport:_vpR}).promise;
              var _pdfImgR={img:_offR,wx:0,wy:_vpR.height/_vpR.scale,ww:_vpR.width/_vpR.scale,wh:_vpR.height/_vpR.scale};
              var _sv3=(_mf.savedViews||[]).slice();
              while(_sv3.length<5)_sv3.push(null);
              var _fstP={
                name:_mf.currentFileName||_mf.name,
                currentFileName:_mf.currentFileName||_mf.name,
                fileKey:_mf.fileKey||_fname,
                doc:null,pdfDoc:_pdocR,pdfImage:_pdfImgR,pdfPageNum:_pnR,
                strokes:_mf.strokes||[],
                dims:_mf.dims||[],
                images:[],
                savedViews:_sv3,
                hiddenLayersArr:_mf.hiddenLayersArr||[],
                tx:_mf.tx||0,ty:_mf.ty||0,scale:_mf.scale||1,fitScale:_mf.fitScale||1,
                fileSize:_mf.fileSize||0,
                insetState:_mf.insetState||null // V1_162: 図面番号欄インセット
              };
              if(_i===_md.currentFileIdx) _activeLocal=_restored.length;
              _restored.push(_fstP);
              _rbufs.push(_buf2);
            }catch(e2){console.warn('[PDFタブ復元]',e2);}
            continue;
          }
          // V1_76: Excel(.xlsx/.xls/.csv)タブの復元。excelWb自体は保存していないため、
          // 保存済みのバイナリ(buf)からXLSX.read()で再構築する（PDFのpdfjsLib.getDocument()と同じ方針）
          if(_mf.isExcel){
            try{
              if(typeof XLSX==='undefined') continue;
              // V1_106: CSVは文字コード自動判定(UTF-8→Shift-JIS)してから文字列として渡す
              var _isCsv176=(_mf.currentFileName||_mf.name||'').toLowerCase().endsWith('.csv');
              var _wbR176=_isCsv176
                ?XLSX.read(_decodeTextAuto(_buf2.slice(0)),{type:'string'})
                :XLSX.read(_buf2.slice(0),{type:'array'});
              var _sv4=(_mf.savedViews||[]).slice();
              while(_sv4.length<5)_sv4.push(null);
              var _fstX={
                name:_mf.currentFileName||_mf.name,
                currentFileName:_mf.currentFileName||_mf.name,
                fileKey:_mf.fileKey||_fname,
                doc:null,pdfDoc:null,pdfImage:null,pdfPageNum:1,
                excelWb:_wbR176,excelSheetIdx:_mf.excelSheetIdx||0,
                strokes:_mf.strokes||[],
                dims:_mf.dims||[],
                images:[],
                savedViews:_sv4,
                hiddenLayersArr:_mf.hiddenLayersArr||[],
                tx:_mf.tx||0,ty:_mf.ty||0,scale:_mf.scale||1,fitScale:_mf.fitScale||1,
                fileSize:_mf.fileSize||0,
                insetState:_mf.insetState||null // V1_162: 図面番号欄インセット
              };
              if(_i===_md.currentFileIdx) _activeLocal=_restored.length;
              _restored.push(_fstX);
              _rbufs.push(_buf2);
            }catch(e2){console.warn('[Excelタブ復元]',e2);}
            continue;
          }
          try{
            var _pdoc=parseAnyDrawing(_buf2,_mf.currentFileName||_mf.name); // V1_173: .tdf対応
            var _sv=(_mf.savedViews||[]).slice();
            while(_sv.length<5)_sv.push(null);
            var _fst={
              name:_mf.currentFileName||_mf.name,
              currentFileName:_mf.currentFileName||_mf.name,
              fileKey:_mf.fileKey||_fname, // V0_160: 記憶(savedViews)のファイル横断ジャンプ判定に必須
              doc:_pdoc,pdfDoc:null,pdfImage:null,pdfPageNum:1,
              strokes:_mf.strokes||[],
              dims:_mf.dims||[],
              images:[],
              savedViews:_sv, // V0_160: 参照のみ残す（もはや読み出しには使わない。後方互換のため保持）
              hiddenLayersArr:_mf.hiddenLayersArr||[],
              tx:_mf.tx||0,ty:_mf.ty||0,scale:_mf.scale||1,fitScale:_mf.fitScale||1,
              fileSize:_mf.fileSize||0,
              insetState:_mf.insetState||null // V1_162: 図面番号欄インセット
            };
            if(_i===_md.currentFileIdx) _activeLocal=_restored.length;
            _restored.push(_fst);
            _rbufs.push(_buf2);
          }catch(e2){}
        }
        if(_restored.length>=1){// V0_113: 1ファイルのみ復元可能な場合もマルチパスを使用
          for(var _k=0;_k<_restored.length;_k++){
            openFiles.push(_restored[_k]);
            if(typeof openFilesBufs!=='undefined') openFilesBufs.push(_rbufs[_k]);
          }
          var _ai=(_activeLocal>=0)?_activeLocal:_restored.length-1;
          currentFileIdx=_ai;
          var _af=openFiles[_ai];
          // V1_55: PDFタブも復元対象になったため、_af.pdfDoc/_af.pdfImageを
          // そのまま採用する（従来はDXF専用の前提でpdfDoc/pdfImageを常にnullにしていた）
          doc=_af.doc||null; pdfDoc=_af.pdfDoc||null; pdfImage=_af.pdfImage||null;
          excelWb=_af.excelWb||null; excelSheetIdx=_af.excelSheetIdx||0; // V1_76
          if(typeof renderExcelView==='function') renderExcelView();
          try{if(typeof pdfPageNum!=='undefined')pdfPageNum=_af.pdfPageNum||1;}catch(e){}
          // V0_140: deep copy廃止 → 参照エイリアス（openFiles[]を唯一の本体とする）
          strokes=_af.strokes;
          dims=_af.dims;
          if(typeof images!=='undefined') images=_af.images||[];
          // V0_160: savedViewsはファイル横断のグローバル項目のため、ファイル毎ではなく
          // 単一のSAVE_KEYからまとめて1回だけ復元する（single-file復元パスと同じ方式）
          try{
            const _svRaw=localStorage.getItem(SAVE_KEY);
            const _svSrc=_svRaw?(JSON.parse(_svRaw).savedViews||[]):[];
            savedViews=[_svSrc[0]||null,_svSrc[1]||null,_svSrc[2]||null,_svSrc[3]||null,_svSrc[4]||null];
          }catch(e){savedViews=[null,null,null,null,null];}
          hiddenLayers=new Set(_af.hiddenLayersArr);
          currentFileName=_af.currentFileName;
          currentFileSize=_af.fileSize;
          tx=_af.tx; ty=_af.ty; scale=_af.scale;
          if(_af.fitScale) fitScale=_af.fitScale;
          const _raw2=localStorage.getItem(SAVE_KEY);
          if(_raw2){
            const _d2=JSON.parse(_raw2);
            bwMode=!!_d2.bwMode;
            currentTool=_d2.currentTool||'sketch';
            if(currentTool==='dx'||currentTool==='dy')currentTool='dxdy';
            if(currentTool==='circDim'||currentTool==='radDim'||currentTool==='lp'||currentTool==='lineLen')currentTool='sketch'; // V0_148.1: DIM/LP系は状態機械(active)を復元できずボタン表示と実動作が食い違うためsketchに正規化 / V1_240: 線の長さも同様の理由でここに追加
            if(_d2.currentColor)currentColor=_d2.currentColor;
            document.querySelectorAll('.color-btn').forEach(b=>{
              const[r,g,b_]=b.dataset.color.split(',').map(Number);
              b.classList.toggle('active',r===currentColor.r&&g===currentColor.g&&b_===currentColor.b);
            });
            if(_d2.currentLW)currentLW=_d2.currentLW;
            document.querySelectorAll('.lw-btn').forEach(b=>{
              b.classList.toggle('active',parseFloat(b.dataset.lw)===currentLW);
            });
            const _lwl=document.getElementById('lwLabel');if(_lwl)_lwl.textContent=currentLW;
            if(_d2.currentHL_Color)currentHL_Color=_d2.currentHL_Color;
            if(_d2.currentHL_LW)currentHL_LW=_d2.currentHL_LW;
            if(_d2.currentDimColor)currentDimColor=_d2.currentDimColor;
            if(_d2.ERASER_RADIUS_PX)ERASER_RADIUS_PX=_d2.ERASER_RADIUS_PX; // V1_207
            if(_d2._lastMeasureTool)_lastMeasureTool=_d2._lastMeasureTool; // V1_210: 前回の計測ツールを復元
            document.querySelectorAll('.hl-color-btn').forEach(b=>{
              const[r,g,b_]=b.dataset.color.split(',').map(Number);
              b.classList.toggle('active',r===currentHL_Color.r&&g===currentHL_Color.g&&b_===currentHL_Color.b);
            });
            document.querySelectorAll('.hl-lw-btn').forEach(b=>{
              b.classList.toggle('active',parseFloat(b.dataset.lw)===currentHL_LW);
            });
            const _hlwl207=document.getElementById('hlLwLabel');if(_hlwl207)_hlwl207.textContent=currentHL_LW; // V1_207
            document.querySelectorAll('.dim-color-btn').forEach(b=>{
              b.classList.toggle('active',b.dataset.color===currentDimColor);
            });
            document.querySelectorAll('.er-btn').forEach(b=>{ // V1_207
              b.classList.toggle('active',parseFloat(b.dataset.er)===ERASER_RADIUS_PX);
            });
            const _erl207=document.getElementById('eraserSizeLabel');if(_erl207)_erl207.textContent=ERASER_RADIUS_PX; // V1_207
            if(_d2.scaleDenom)document.getElementById('scaleDenom').value=_d2.scaleDenom;
            if(typeof updateBwToggleBtn==='function')updateBwToggleBtn();
            document.querySelectorAll('.tool-btn').forEach(b=>{
              b.classList.toggle('active',b.dataset.tool===currentTool);
            });
            {const _mb207=document.getElementById('measureToggleBtn');if(_mb207)_mb207.classList.toggle('tool-active',['dxdy','diag','ll','lp','circDim','radDim','lineLen'].indexOf(currentTool)>=0);} // V1_207: tool.jsのconst _MEASURE_TOOL_LABELSは別scriptタグのためbareでは参照できず、ここでは同じ判定を直接書く
              // V2_19: 【注意】計測ツールの種類をtool.js側(_MEASURE_TOOL_LABELS/_MEASURE_TOOL_ICON_INNER/
              // _TOOL_COLOR_MODE等)で追加・変更した場合、この配列(および同じ配列を持つstorage.js内の
              // もう1箇所)も必ず手動で追従させること。ここは自動連動していないため、更新を怠ると
              // 復元直後だけ計測ボタンの枠ハイライトがずれる不具合が再発する(デバッグ計画での指摘事項)
            if(typeof _syncMeasureToggleBtnIcon==='function') _syncMeasureToggleBtnIcon(); // V1_219: 計測ボタンのアイコンも復元したcurrentToolに同期
            if(_d2.dimensionTextMode&&_d2.dimensionTextMode!=='manual')dimensionTextMode=_d2.dimensionTextMode; // V0_154: manual廃止
            if(typeof updateDimTextModeUI==='function')updateDimTextModeUI();
            if(_d2.inputMode)inputMode=_d2.inputMode;
            if(typeof updateInputModeUI==='function')updateInputModeUI();
            if(typeof updateToolColorDots==='function')updateToolColorDots();
          }
          const _nd=document.getElementById('noDrawingMsg');if(_nd)_nd.style.display='none';
          // V1_55: PDFタブ復元時、ページ送りUI(#pdfPageCtrl/#pageInfo)もswitchToFile()と
          // 同じ内容で復元する（従来はDXF専用の前提でこのUIに一切触れていなかった）
          {var _ppcR=document.getElementById('pdfPageCtrl');
          if(_ppcR) _ppcR.style.display=pdfDoc?'':'none';
          if(pdfDoc){var _piR=document.getElementById('pageInfo');if(_piR)_piR.textContent=(pdfPageNum||1)+'/'+pdfDoc.numPages;}}
          updateFileNameDisplay();
          [0,1,2,3,4].forEach(function(i){updateViewmemoState(i);});
          buildLayerModal();
          if(typeof buildSnapCache==='function')buildSnapCache();
          if(typeof checkPerfMode==='function')checkPerfMode();
          scheduleDraw();scheduleOverlay();updateUndoRedo();
          if(typeof buildSearchIndex==='function')buildSearchIndex();
          if(typeof updateFileNavUI==='function')updateFileNavUI();
          if(typeof _diApplyStateFromFile==='function')_diApplyStateFromFile(); // V1_162: 図面番号欄インセットを復元
          _multiOk=true;
        }
      }
    }
  }catch(e){}
  if(_multiOk) return;

  // ── 単一ファイル復元（従来パス）─────────────────────────────
  try{
    var _restoreBuf=null;
    // V0_114: ファイル名をSAVE_KEY→FILE_KEYの順で取得し、IDB優先→localStorageで復元
    var _sfName=null,_sfKey=null;
    try{var _sfRaw=localStorage.getItem(SAVE_KEY);if(_sfRaw){var _sfParsed=JSON.parse(_sfRaw);_sfName=_sfParsed.currentFileName;_sfKey=_sfParsed.fileKey||null;}}catch(e){}
    if(!_sfName){try{var _sfFr=localStorage.getItem(FILE_KEY);if(_sfFr)_sfName=JSON.parse(_sfFr).name;}catch(e){}}
    if(_sfName){
      _restoreBuf=await _lsIdbGetP(_sfKey||_sfName,FILE_KEY); // V0_116: fileKey優先→name fallback→localStorageフォールバック
      if(_restoreBuf){
        currentFileName=_sfName;
        currentFileSize=_restoreBuf.byteLength;
        if(_sfName.toLowerCase().endsWith('.pdf')){
          await loadPDF(_restoreBuf);
        } else if(typeof _isExcelName==='function'&&_isExcelName(_sfName)){ // V1_76
          loadExcel(_restoreBuf,_sfName.toLowerCase().endsWith('.csv')); // V1_106: CSVは文字コード自動判定させる
        } else {
          doc=parseAnyDrawing(_restoreBuf,_sfName);detectScale(); // V1_173: .tdf対応
        }
        const nd=document.getElementById('noDrawingMsg');if(nd)nd.style.display='none';
        updateFileNameDisplay();
      }
    }
    const raw=localStorage.getItem(SAVE_KEY);if(!raw){buildLayerModal();return;}
    const _rawParsed=JSON.parse(raw);
    if(_restoreBuf&&_rawParsed.fileSize&&_rawParsed.fileSize!==currentFileSize){buildLayerModal();scheduleDraw();return;}
    const d=_rawParsed;
    strokes=d.strokes||[];dims=d.dims||[];
    {const sv=d.savedViews||[];savedViews=[sv[0]||null,sv[1]||null,sv[2]||null,sv[3]||null,sv[4]||null];}
    tx=d.tx||0;ty=d.ty||0;scale=d.scale||1;
    if(d.fitScale) fitScale=d.fitScale;
    bwMode=!!d.bwMode;
    if(d.hiddenLayers)hiddenLayers=new Set(d.hiddenLayers);
    currentTool=d.currentTool||'sketch';
    if(currentTool==='dx'||currentTool==='dy')currentTool='dxdy';
    if(currentTool==='circDim'||currentTool==='radDim'||currentTool==='lp'||currentTool==='lineLen')currentTool='sketch'; // V0_148.1: DIM/LP系は状態機械(active)を復元できずボタン表示と実動作が食い違うためsketchに正規化 / V1_240: 線の長さも同様の理由でここに追加
    if(d.currentColor)currentColor=d.currentColor;
    document.querySelectorAll('.color-btn').forEach(b=>{
      const[r,g,b_]=b.dataset.color.split(',').map(Number);
      b.classList.toggle('active',r===currentColor.r&&g===currentColor.g&&b_===currentColor.b);
    });
    if(d.currentLW)currentLW=d.currentLW;
    document.querySelectorAll('.lw-btn').forEach(b=>{
      b.classList.toggle('active',parseFloat(b.dataset.lw)===currentLW);
    });
    const lwl=document.getElementById('lwLabel');if(lwl)lwl.textContent=currentLW;
    if(d.currentHL_Color)currentHL_Color=d.currentHL_Color;
    if(d.currentHL_LW)currentHL_LW=d.currentHL_LW;
    if(d.currentDimColor)currentDimColor=d.currentDimColor;
    if(d.ERASER_RADIUS_PX)ERASER_RADIUS_PX=d.ERASER_RADIUS_PX; // V1_207
    if(d._lastMeasureTool)_lastMeasureTool=d._lastMeasureTool; // V1_210: 前回の計測ツールを復元
    document.querySelectorAll('.hl-color-btn').forEach(b=>{
      const[r,g,b_]=b.dataset.color.split(',').map(Number);
      b.classList.toggle('active',r===currentHL_Color.r&&g===currentHL_Color.g&&b_===currentHL_Color.b);
    });
    document.querySelectorAll('.hl-lw-btn').forEach(b=>{
      b.classList.toggle('active',parseFloat(b.dataset.lw)===currentHL_LW);
    });
    const hlwl207=document.getElementById('hlLwLabel');if(hlwl207)hlwl207.textContent=currentHL_LW; // V1_207
    document.querySelectorAll('.dim-color-btn').forEach(b=>{
      b.classList.toggle('active',b.dataset.color===currentDimColor);
    });
    document.querySelectorAll('.er-btn').forEach(b=>{ // V1_207
      b.classList.toggle('active',parseFloat(b.dataset.er)===ERASER_RADIUS_PX);
    });
    const erl207=document.getElementById('eraserSizeLabel');if(erl207)erl207.textContent=ERASER_RADIUS_PX; // V1_207
    if(d.scaleDenom)document.getElementById('scaleDenom').value=d.scaleDenom;
    if(typeof updateBwToggleBtn==='function') updateBwToggleBtn();
    document.querySelectorAll('.tool-btn').forEach(b=>{
      b.classList.toggle('active',b.dataset.tool===currentTool);
    });
    {const mb207=document.getElementById('measureToggleBtn');if(mb207)mb207.classList.toggle('tool-active',['dxdy','diag','ll','lp','circDim','radDim','lineLen'].indexOf(currentTool)>=0);} // V1_207: tool.jsのconst _MEASURE_TOOL_LABELSは別scriptタグのためbareでは参照できず、ここでは同じ判定を直接書く
              // V2_19: 【注意】計測ツールの種類をtool.js側(_MEASURE_TOOL_LABELS/_MEASURE_TOOL_ICON_INNER/
              // _TOOL_COLOR_MODE等)で追加・変更した場合、この配列(および同じ配列を持つstorage.js内の
              // もう1箇所)も必ず手動で追従させること。ここは自動連動していないため、更新を怠ると
              // 復元直後だけ計測ボタンの枠ハイライトがずれる不具合が再発する(デバッグ計画での指摘事項)
    if(typeof _syncMeasureToggleBtnIcon==='function') _syncMeasureToggleBtnIcon(); // V1_219: 計測ボタンのアイコンも復元したcurrentToolに同期
    [0,1,2,3,4].forEach(i=>updateViewmemoState(i));
    buildLayerModal();
    scheduleDraw();scheduleOverlay();updateUndoRedo();
    if(d.dimensionTextMode&&d.dimensionTextMode!=='manual')dimensionTextMode=d.dimensionTextMode; // V0_154: manual廃止
    if(typeof updateDimTextModeUI==='function')updateDimTextModeUI();
    if(d.inputMode)inputMode=d.inputMode;
    if(typeof updateInputModeUI==='function')updateInputModeUI();
    if(typeof updateToolColorDots==='function')updateToolColorDots();
    // V0_135: PDFページ番号復元（loadPDFはpage1を表示するため、保存ページに再移動）
    if(d.pdfPageNum&&d.pdfPageNum>1&&typeof pdfDoc!=='undefined'&&pdfDoc&&typeof renderPdfPage==='function'){
      pdfPageNum=d.pdfPageNum;
      var _pi=document.getElementById('pageInfo');if(_pi)_pi.textContent=pdfPageNum+'/'+pdfDoc.numPages;
      renderPdfPage(pdfPageNum);
    }
    // V0_111: 復元ファイルをopenFiles[]に登録
    if(currentFileName && typeof openFiles!=='undefined' && openFiles.length===0){
      openFiles.push({name:currentFileName,fileKey:_sfKey||currentFileName});
      currentFileIdx=0;
      if(typeof openFilesBufs!=='undefined'&&_restoreBuf) openFilesBufs[0]=_restoreBuf; // V0_112
      // V0_140: saveCurrentFileState廃止 → strokes/dims/images/savedViewsを参照として設定
      {var _singleF=openFiles[0];_singleF.strokes=strokes;_singleF.dims=dims;_singleF.images=typeof images!=='undefined'?images:[];_singleF.savedViews=savedViews;_singleF.doc=doc;_singleF.hiddenLayersArr=Array.from(hiddenLayers);_singleF.tx=tx;_singleF.ty=ty;_singleF.scale=scale;_singleF.fitScale=fitScale;_singleF.currentFileName=currentFileName;_singleF.fileSize=currentFileSize;_singleF.excelWb=(typeof excelWb!=='undefined'?excelWb:null);_singleF.excelSheetIdx=(typeof excelSheetIdx!=='undefined'?excelSheetIdx:0);_singleF.insetState=d.insetState||null;} // V1_162: 図面番号欄インセット
      if(typeof updateFileNavUI==='function') updateFileNavUI();
      if(typeof _diApplyStateFromFile==='function') _diApplyStateFromFile(); // V1_162: 図面番号欄インセットを復元
    }
  }catch(e){}
  if(typeof verify==='function')verify('tryRestore:done');
}

// =========================================================
// V0_121: 自動バックアップ（dxfViewerBackupDB）
// 既存の dxfViewerFilesDB とは完全に別DB — 既存処理へ影響ゼロ
// =========================================================
const _BK_IDB_NAME='dxfViewerBackupDB';
const _BK_IDB_VER=1;
const _BK_IDB_STORE='backups';
const _BK_COOLDOWN=60000; // 60秒
const _BK_KEEP=5;         // ファイルごとに保持する世代数

// V2_46: 60秒クールダウンごとに呼ばれるが、従来は毎回indexedDB.open()で新規接続を
// 開き、一度もclose()していなかった。_dvOpenIdb()と同じ対策（接続キャッシュ＋
// onclose検知による自動再接続）を適用した
var _bkIdbConn=null;
function _bkIdbOpen(cb){
  if(_bkIdbConn){cb(null,_bkIdbConn);return;}
  var req=indexedDB.open(_BK_IDB_NAME,_BK_IDB_VER);
  req.onupgradeneeded=function(e){
    var db=e.target.result;
    if(!db.objectStoreNames.contains(_BK_IDB_STORE)){
      var store=db.createObjectStore(_BK_IDB_STORE,{keyPath:'id',autoIncrement:true});
      store.createIndex('fileKey','fileKey',{unique:false});
      store.createIndex('ts','ts',{unique:false});
    }
  };
  req.onsuccess=function(e){
    _bkIdbConn=e.target.result;
    _bkIdbConn.onclose=function(){_bkIdbConn=null;};
    cb(null,_bkIdbConn);
  };
  req.onerror=function(e){cb(e.target.error,null);};
}

// dims/strokes をバックアップ保存し、古い世代を削除する
function _bkPut(fileKey,dims,strokes){
  if(!fileKey) return;
  _bkIdbOpen(function(err,db){
    if(err) return;
    // 保存
    var wtx=db.transaction(_BK_IDB_STORE,'readwrite');
    wtx.onerror=function(e){console.warn('[Backup] wtx failed',e.target.error);};
    var store=wtx.objectStore(_BK_IDB_STORE);
    var addReq=store.add({fileKey:fileKey,ts:Date.now(),dims:dims,strokes:strokes});
    addReq.onerror=function(e){console.warn('[Backup] add failed',e.target.error);};
    wtx.oncomplete=function(){
      // 世代削除: fileKey の全レコードを ts 昇順で取得し、_BK_KEEP 超過分を削除
      var rtx=db.transaction(_BK_IDB_STORE,'readwrite');
      var rstore=rtx.objectStore(_BK_IDB_STORE);
      var idx=rstore.index('fileKey');
      var req2=idx.getAll(fileKey);
      req2.onerror=function(e){console.warn('[Backup] getAll failed',e.target.error);};
      req2.onsuccess=function(ev){
        var recs=ev.target.result;
        if(recs.length<=_BK_KEEP) return;
        recs.sort(function(a,b){return a.ts-b.ts;});
        var del=recs.slice(0,recs.length-_BK_KEEP);
        var dtx=db.transaction(_BK_IDB_STORE,'readwrite');
        dtx.onerror=function(e){console.warn('[Backup] dtx failed',e.target.error);};
        var dstore=dtx.objectStore(_BK_IDB_STORE);
        del.forEach(function(r){dstore.delete(r.id);});
      };
    };
  });
}

// バックアップ実行
function _doBkSave(){
  _bkTimer=null;
  _bkLastTs=Date.now();
  if(typeof verify==='function')verify('_doBkSave');
  var fk=(typeof _fileKey==='function'?_fileKey(currentFileName,currentFileSize):null)||currentFileName;
  if(!fk) return;
  // V0_140: openFiles[currentFileIdx]を直接参照（グローバル変数ではなく）
  var _bkCf=(typeof openFiles!=='undefined'&&currentFileIdx>=0)?openFiles[currentFileIdx]:null;
  var _bkStrokes=_bkCf&&_bkCf.strokes?_bkCf.strokes:strokes;
  var _bkDims=_bkCf&&_bkCf.dims?_bkCf.dims:dims;
  _bkPut(fk,_bkDims.slice(),_bkStrokes.map(function(s){return Object.assign({},s,{pts:s.pts.slice()});}));
}

// クールダウン方式スケジューラ
// 最後のバックアップから60秒以上経過 → 即時実行
// 60秒未満 → 残り時間後に実行（上書きスケジュール）
function scheduleBkSave(){
  clearTimeout(_bkTimer);
  var elapsed=Date.now()-_bkLastTs;
  var remaining=_BK_COOLDOWN-elapsed;
  if(remaining<=0){
    _doBkSave();
  }else{
    _bkTimer=setTimeout(_doBkSave,remaining);
  }
}

// =========================================================
// V0_127: .dxfview 自動保存（IndexedDB: dxfViewerDxfviewDB）
// doSave() のたびに dims/strokes を IDB へ自動保存する
// =========================================================
var _DV_IDB_NAME='dxfViewerDxfviewDB';
// V1_40: _dvAutoSave()はdoSave()のたび（編集操作のたび、約800msデバウンス）に
// 呼ばれる高頻度な処理だが、従来は毎回indexedDB.open()で新規接続を開き、
// 一度もclose()していなかった。これはV1_24/V1_36でdxfIndex用DB(_idbConn)側に
// 実際にクラッシュを引き起こしたのと同じ「未クローズ接続が溜まる」パターンで、
// 長時間の編集セッションで同様の問題が起きうるため、同じ対策（接続キャッシュ＋
// onclose検知による自動再接続）をこちらにも適用した
var _dvIdbConn=null;
function _dvOpenIdb(cb){
  if(_dvIdbConn){cb(null,_dvIdbConn);return;}
  var req=indexedDB.open(_DV_IDB_NAME,1);
  req.onupgradeneeded=function(e){e.target.result.createObjectStore('dv',{keyPath:'fk'});};
  req.onsuccess=function(e){
    _dvIdbConn=e.target.result;
    _dvIdbConn.onclose=function(){_dvIdbConn=null;};
    cb(null,_dvIdbConn);
  };
  req.onerror=function(e){cb(e.target.error,null);};
}
function _dvAutoSave(){
  try{
    var fk=(typeof _fileKey==='function'?_fileKey(currentFileName,currentFileSize):null)||currentFileName||'';
    if(!fk) return; // V0_134: fileKeyなし（ファイル未読込）のみスキップ。空データも保存して削除操作を反映
    // V0_140: openFiles[currentFileIdx]を直接参照（グローバル変数ではなく）
    var _dvCf=(typeof openFiles!=='undefined'&&currentFileIdx>=0)?openFiles[currentFileIdx]:null;
    var _dvStrokes=_dvCf&&_dvCf.strokes?_dvCf.strokes:strokes;
    var _dvDims=_dvCf&&_dvCf.dims?_dvCf.dims:dims;
    var _dvFn=(_dvCf&&_dvCf.currentFileName)||currentFileName||'';
    var _dvFs=(_dvCf&&_dvCf.fileSize!=null)?_dvCf.fileSize:currentFileSize||0;
    if(typeof verify==='function')verify('IDB保存開始',{fk:fk});
    var _rec={
      fk:fk,
      format:'dxfview',          version:1,
      fileName:_dvFn,fileSize:_dvFs,
      savedAt:new Date().toISOString(),
      dims:_dvDims.slice(),
      strokes:_dvStrokes.map(function(s){return Object.assign({},s,{pts:s.pts.slice()});})
    };
    // V1_40: 接続が無効化されていた場合に備え、transaction()呼び出しをtry/catchで
    // 囲み、失敗時はキャッシュを破棄して1回だけ再接続してから保存する
    function _dvPut(db,isRetry){
      try{
        var tx=db.transaction('dv','readwrite');
        tx.objectStore('dv').put(_rec);
        tx.oncomplete=function(){if(typeof verify==='function')verify('IDB保存成功',{fk:fk});};
        tx.onerror=function(ev){if(typeof verifyWarn==='function')verifyWarn('IDB保存失敗',{fk:fk,err:String(ev.target.error)});console.warn('[dxfview auto-save] tx error',ev.target.error);};
      }catch(er){
        if(isRetry){console.warn('[dxfview auto-save] put error(retry)',er);return;}
        _dvIdbConn=null;
        _dvOpenIdb(function(err2,db2){
          if(err2){console.warn('[dxfview auto-save] reopen error',err2);return;}
          _dvPut(db2,true);
        });
      }
    }
    _dvOpenIdb(function(err,db){
      if(err){if(typeof verifyWarn==='function')verifyWarn('IDB保存失敗(open)',{fk:fk});console.warn('[dxfview auto-save] open error',err);return;}
      _dvPut(db,false);
    });
  }catch(e){console.warn('[dxfview auto-save]',e);}
}
