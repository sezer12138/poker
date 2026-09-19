# macOS: requires say (Tingting) and ffmpeg. Run from repository root.
from pathlib import Path
import subprocess, tempfile, wave, math, random, struct, shutil
out=Path('apps/web/static/audio'); out.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory() as tmp:
 for name,text in {'fold':'弃牌','check':'过牌','call':'跟注','raiseTo':'加注','allIn':'全押','raiseAmount':'加注到','allInAmount':'全押，本轮共','chipUnit':'筹码',
   **{f'n{i}':word for i,word in enumerate('零一二三四五六七八九')},
   'ten':'十','hundred':'百','thousand':'千','tenThousand':'万','hundredMillion':'亿','trillion':'兆'}.items():
  a=Path(tmp)/f'{name}.aiff'
  subprocess.run(['say','-v','Tingting','-r','205','-o',str(a),text],check=True)
  subprocess.run(['ffmpeg','-loglevel','error','-y','-i',str(a),'-af','silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,afade=t=in:d=0.01','-ar','24000','-b:a','64k',str(out/f'{name}.mp3')],check=True)
 random.seed(42)
 for name,duration in [('chips',.42),('deal',.3),('tap',.16),('win',.85)]:
  rate=24000;samples=[]
  for i in range(int(rate*duration)):
   t=i/rate
   if name=='chips':
    value=sum((math.sin(2*math.pi*(1800+j*390)*max(0,t-j*.065))*.15+random.uniform(-.15,.15))*math.exp(-max(0,t-j*.065)*65) for j in range(4) if t>=j*.065)
   elif name=='deal': value=random.uniform(-.4,.4)*math.sin(math.pi*t/duration)**2*math.exp(-t*7)
   elif name=='tap': value=.5*math.sin(2*math.pi*420*t)*math.exp(-t*42)
   else: value=sum(.14*math.sin(2*math.pi*f*(t-j*.12))*math.exp(-(t-j*.12)*6) for j,f in enumerate([523.25,659.25,783.99]) if t>=j*.12)
   value*=min(1,t/.005,(duration-t)/.02)
   samples.append(struct.pack('<h',int(max(-1,min(1,value))*32767)))
  wav=Path(tmp)/'effect.wav'
  with wave.open(str(wav),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(rate);w.writeframes(b''.join(samples))
  subprocess.run(['ffmpeg','-loglevel','error','-y','-i',str(wav),'-b:a','64k',str(out/f'{name}.mp3')],check=True)
 target=Path('apps/wechat/audio');target.mkdir(exist_ok=True)
 for f in out.glob('*.mp3'):shutil.copy2(f,target/f.name)
print('Generated', len(list(out.glob('*.mp3'))), 'clips per client')
