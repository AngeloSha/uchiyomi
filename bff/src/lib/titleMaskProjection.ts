// Map only alpha from the worker grid. Every RGB byte remains from the immutable cover snapshot.
import type { ExtractionRect } from './titleExtractionWorker';
export function projectTitleAlpha(alpha:Uint8Array,candidateWidth:number,candidateHeight:number,region:ExtractionRect,
  preparedWidth:number,preparedHeight:number,width:number,height:number):Uint8Array {
  const dims=[candidateWidth,candidateHeight,preparedWidth,preparedHeight,width,height];
  if(dims.some(n=>!Number.isSafeInteger(n)||n<1)||width*height>4_320_000||preparedWidth*preparedHeight>12_000_000
    ||alpha.length!==candidateWidth*candidateHeight)throw new Error('invalid_mask_geometry');
  const coordinates=[region.left*preparedWidth,region.top*preparedHeight,region.width*preparedWidth,region.height*preparedHeight];
  if(coordinates.some(n=>!Number.isFinite(n)||Math.abs(n-Math.round(n))>1e-5))throw new Error('invalid_mask_geometry');
  const[left,top,w,h]=coordinates.map(Math.round);
  if(left<0||top<0||w!==candidateWidth||h!==candidateHeight||left+w>preparedWidth||top+h>preparedHeight)throw new Error('invalid_mask_geometry');
  const result=new Uint8Array(width*height);
  for(let y=0;y<height;y++){
    const sy=Math.floor((y+.5)*preparedHeight/height)-top;if(sy<0||sy>=candidateHeight)continue;
    for(let x=0;x<width;x++){
      const sx=Math.floor((x+.5)*preparedWidth/width)-left;
      if(sx>=0&&sx<candidateWidth)result[y*width+x]=alpha[sy*candidateWidth+sx];
    }
  }
  return result;
}
export function sourceRgba(rgb:Uint8Array,alpha:Uint8Array):Buffer {
  if(rgb.length!==alpha.length*3)throw new Error('invalid_mask_geometry');
  const rgba=Buffer.allocUnsafe(alpha.length*4);
  for(let n=0;n<alpha.length;n++){rgba[n*4]=rgb[n*3];rgba[n*4+1]=rgb[n*3+1];rgba[n*4+2]=rgb[n*3+2];rgba[n*4+3]=alpha[n];}
  return rgba;
}
