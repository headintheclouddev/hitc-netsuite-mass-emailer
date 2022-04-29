/**
 * hitc_mass_emailer_unsubscribe.ts
 * by Head in the Cloud Development, Inc.
 * gurus@headintheclouddev.com
 *
 * @NScriptName HITC Mass Emailer Unsubscribe Suitelet
 * @NScriptType Suitelet
 * @NApiVersion 2.1
 */
define(["require", "exports", "N/log", "N/record"], function (require, exports, log, record) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.onRequest = void 0;
    function onRequest(context) {
        const recordType = context.request.parameters['etype'];
        const recordIdIn = Number(context.request.parameters['eid']);
        const campaignId = context.request.parameters['cid'];
        if (context.request.method == 'GET') {
            log.debug('Inputs', `${recordType} ${recordIdIn} ${campaignId}`);
            context.response.write(`
      <html lang="en">
        <form method="post">
          Enter the email address to unsubscribe: <input type="email" name="email" required /><br />
          <div style="display: none;">
            <input type="text" name="etype" value="${recordType}" />
            <input type="number" name="eid" value="${recordIdIn}" />
            <input type="number" name="cid" value="${campaignId}" />
          </div>
          <input type="submit" />
        </form>
      </html>
    `);
        }
        else { // POST
            const emailAddr = context.request.parameters['email'];
            const recordId = Number(context.request.parameters['recordid']);
            if (recordId) { // User submitted updates to their subscription
                const subscribeAll = context.request.parameters['subscribe']; // Will be T or F
                try {
                    const rec = record.load({ type: recordType, id: recordId });
                    for (let i = 0; i < rec.getLineCount({ sublistId: 'subscriptions' }); i++) {
                        const subscriptionId = rec.getSublistValue({ sublistId: 'subscriptions', fieldId: 'subscription', line: i });
                        const subscribeInput = context.request.parameters[`subscription_${subscriptionId}`]; // Will be "on" or else undefined
                        log.debug('Subscription Input', `ID: ${subscriptionId}: ${subscribeInput}, type ${typeof subscribeInput}.`);
                        if (subscribeAll == 'T' && subscribeInput)
                            rec.setSublistValue({ sublistId: 'subscriptions', fieldId: 'subscribed', line: i, value: true });
                        else
                            rec.setSublistValue({ sublistId: 'subscriptions', fieldId: 'subscribed', line: i, value: false });
                    }
                    rec.save();
                    context.response.write('Your subscription preferences have been updated.  You may close this window now.');
                }
                catch (e) {
                    log.error('Failed to update record', e.message);
                    context.response.write('Uh oh, something went wrong!');
                }
            }
            else { // User has just logged in
                context.response.write(displayEmailSubscriptionPreferences(recordType, recordIdIn / 7777, emailAddr));
            }
        }
    }
    exports.onRequest = onRequest;
    function displayEmailSubscriptionPreferences(recordType, recordId, emailAddr) {
        let subscriptionsHTML = '';
        try {
            log.debug('Logging In', `${recordType} ${recordId} ${emailAddr}`);
            const rec = record.load({ type: recordType, id: recordId });
            if (rec.getValue('email') != emailAddr)
                throw 'Email address mismatch. Email entered: ${emailAddr}.';
            for (let i = 0; i < rec.getLineCount({ sublistId: 'subscriptions' }); i++) {
                const subscribed = rec.getSublistValue({ sublistId: 'subscriptions', fieldId: 'subscribed', line: i });
                const subscriptionId = rec.getSublistValue({ sublistId: 'subscriptions', fieldId: 'subscription', line: i });
                const subscriptionName = rec.getSublistText({ sublistId: 'subscriptions', fieldId: 'subscription', line: i });
                const checked = subscribed ? 'checked' : '';
                subscriptionsHTML += ` <input type="checkbox" name="subscription_${subscriptionId}" ${checked} /> <b>${subscriptionName}</b><br />`;
            }
        }
        catch (e) {
            log.error('Failed to log user in', e.message);
            return 'Uh oh, something went wrong!';
        }
        return `
    <html lang="en">
      <form method="post">
        <p style="border: thin solid black; background-color: #bbeeff; padding: 4px;">Email: ${emailAddr}</p>
        <input type="radio" name="subscribe" value="T" checked> Yes, please send me emails about the following categories:<br />
        <div style="margin: 15px;">
          ${subscriptionsHTML}
        </div>
        <input type="radio" name="subscribe" value="F"> No, I do not wish to receive any subscription emails. I understand that I will continue to receive account-specific emails.
        <div style="display: none;">
          <input type="text" name="etype" value="${recordType}" />
          <input type="number" name="recordid" value="${recordId}" />
        </div><br /><br />
        <input type="submit" />
      </form>
    </html>
  `;
    }
});
