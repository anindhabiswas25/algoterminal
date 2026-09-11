export default function Announcement() {
  return (
    <>
    <div className="announce-row">
      <div className="row">
        <a className="announce-link animate-fade-in" href="#" target="_blank" rel="noreferrer noopener">
          <div className="announce" data-color="neutral" data-size="large" data-variant="muted">
            <div className="in">
              <div className="lead"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M248,120a48.05,48.05,0,0,0-48-48H160.2c-2.91-.17-53.62-3.74-101.91-44.24A16,16,0,0,0,32,40V200a16,16,0,0,0,26.29,12.25c37.77-31.68,77-40.76,93.71-43.3v31.72A16,16,0,0,0,159.12,214l11,7.33A16,16,0,0,0,194.5,212l11.77-44.36A48.07,48.07,0,0,0,248,120ZM48,199.93V40h0c42.81,35.91,86.63,45,104,47.24v65.48C134.65,155,90.84,164.07,48,199.93Zm131,8,0,.11-11-7.33V168h21.6ZM200,152H168V88h32a32,32,0,1,1,0,64Z" /></svg><span className="t">Announcement</span></div>
              <div className="sep" role="separator" aria-orientation="vertical" aria-hidden="true"></div>
              <span className="msg">Token Terminal MCP is here</span>
              <svg className="arrow" xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" /></svg>
            </div>
          </div>
        </a>
      </div>
    </div>
    </>
  );
}
