# MCP tool contract

`browser_status({})` and `browser_tabs({})` read service and allowed Xero page state. `browser_bind({tabId,scope:{project,entity,period,matter},anchors:["Exact Entity","FY2026"]})` produces sessionId and revision. `browser_observe({sessionId,screenshot:true})` returns controls + current revision + optional PNG bytes.

`browser_act({sessionId,expectedRevision,idempotencyKey,action:{kind:"click",selector:"button.save"},expectedPoststate:{visibleTextIncludes:["Draft saved"]}})` executes one frontend-selected action and reads the resulting DOM. `expectedPoststate` supports `url`, `visibleTextIncludes`, `visibleTextExcludes`, `controlsIncludeLabel`. Only `POSTSTATE_VERIFIED` means its explicit assertion passed; `ACTION_OBSERVED_NO_ASSERTION` means only an observation followed the command. `UNCERTAIN_OUTCOME` must not be replayed blindly.

Action payloads: click/double_click/hover with `selector` or `x,y`; drag `x,y,toX,toY`; scroll `deltaY` with optional `x,y,deltaX`; type `selector,text`; press `selector,key` where key is Tab/Escape/Backspace/Delete/Enter/ArrowUp/ArrowDown/ArrowLeft/ArrowRight/Space; select native HTML `<select>` with `selector,value`; wait `ms` 100-5000; navigate `url` within Xero HTTPS only. UI control targets are inspected before action; clicks to risky submit/lodge/pay/sign/delete targets are denied.

Browser readback is a page observation, NOT independent source reconciliation, lodgement authority or successful Xero application integration. Cross-origin frames, file uploads/downloads, credentials and Xero API writes are not implemented.
