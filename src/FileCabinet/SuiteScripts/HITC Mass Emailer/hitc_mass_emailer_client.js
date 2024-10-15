/**
 * hitc_mass_emailer_client.ts
 * by Head in the Cloud Development, Inc.
 * gurus@headintheclouddev.com
 *
 * @NScriptType ClientScript
 * @NApiVersion 2.1
 */
define(["require", "exports", "N/ui/dialog", "N/ui/message", "N/record", "N/search"], function (require, exports, dialog, message, record, search) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.pageInit = pageInit;
    exports.fieldChanged = fieldChanged;
    exports.saveRecord = saveRecord;
    function pageInit(context) {
        const transactionParameter = getParameter('transaction'); // This isn't currently in use. Can be hooked up to a button on transactions.
        if (transactionParameter)
            context.currentRecord.setValue('custpage_transaction', transactionParameter);
    }
    function fieldChanged(context) {
        console.log('Field Changed', context.sublistId, context.fieldId);
        const subject = context.currentRecord.getValue('custpage_subject');
        const template = context.currentRecord.getValue('custpage_template');
        const transaction = context.currentRecord.getValue('custpage_transaction');
        const transText = context.currentRecord.getText('custpage_transaction');
        if (context.fieldId == 'custpage_contact_contact') { // Source in company name & email
            const contact = context.currentRecord.getCurrentSublistValue({ sublistId: 'custpage_contacts', fieldId: 'custpage_contact_contact' });
            if (contact)
                search.lookupFields.promise({ type: 'contact', id: contact, columns: ['company', 'email'] }).then((contactValues) => {
                    console.log('Contact values', contactValues);
                    const companies = contactValues['company'];
                    const companyName = (companies && companies.length > 0) ? companies[0].text : '';
                    const emailAddress = contactValues.email || ''; // It'll be undefined if the user did not have access to that contact
                    context.currentRecord.setCurrentSublistValue({ sublistId: 'custpage_contacts', fieldId: 'custpage_contact_company', value: companyName });
                    context.currentRecord.setCurrentSublistValue({ sublistId: 'custpage_contacts', fieldId: 'custpage_contact_email', value: emailAddress });
                }).catch((err) => {
                    console.log('fieldChanged - contact lookup error', err);
                });
        }
        else if (['custpage_employee_employee', 'custpage_partner_partner', 'custpage_customer_customer'].includes(context.fieldId)) { // Source in email
            const entityId = context.currentRecord.getCurrentSublistValue({ sublistId: context.sublistId, fieldId: context.fieldId });
            if (entityId)
                search.lookupFields.promise({ type: 'entity', id: entityId, columns: ['email', 'type'] }).then((entityValues) => {
                    console.log('Entity values', entityValues);
                    const entityTypes = entityValues['type']; // May be like: [{ value: 'CustJob', text: 'Customer' }]
                    const fieldId = `custpage_${entityTypes[0].text.toLowerCase()}_email`;
                    context.currentRecord.setCurrentSublistValue({ sublistId: context.sublistId, fieldId, value: entityValues.email });
                });
        }
        else if (context.fieldId == 'custpage_transaction' && !subject && transaction && !template) {
            context.currentRecord.setValue('custpage_subject', transText);
        }
        else if (context.fieldId == 'custpage_template') {
            setTemplatePreviewContent(context.currentRecord, template);
        }
        else if (['custpage_search_type', 'custpage_populate_list'].includes(context.fieldId)) {
            const searchId = context.currentRecord.getValue('custpage_saved_search');
            const populateList = context.currentRecord.getValue('custpage_populate_list');
            const searchType = context.currentRecord.getValue('custpage_search_type');
            if (searchId && searchType && populateList)
                fillListFromSearch(searchType, searchId, context.currentRecord);
        }
        else if (context.fieldId == 'custpage_saved_search') {
            const searchId = context.currentRecord.getValue('custpage_saved_search');
            if (searchId) {
                search.load.promise({ id: searchId }).then((savedSearch) => {
                    context.currentRecord.setValue({ fieldId: 'custpage_search_type', value: savedSearch.searchType });
                });
            }
        }
    }
    function saveRecord(context) {
        // Require template OR subject and body
        const template = context.currentRecord.getValue('custpage_template');
        const subject = context.currentRecord.getValue('custpage_subject');
        const body = context.currentRecord.getValue('custpage_body');
        if (!template && (!subject && body)) {
            alert('You must either select a Template or enter an email subject and body');
            return false;
        }
        // Require at least one recipient
        const contactCount = context.currentRecord.getLineCount({ sublistId: 'custpage_contacts' });
        const employeeCount = context.currentRecord.getLineCount({ sublistId: 'custpage_employees' });
        const customerCount = context.currentRecord.getLineCount({ sublistId: 'custpage_customers' });
        const partnerCount = context.currentRecord.getLineCount({ sublistId: 'custpage_partners' });
        const populateList = context.currentRecord.getValue('custpage_populate_list');
        const savedSearch = context.currentRecord.getValue('custpage_saved_search');
        if (!contactCount && !employeeCount && !partnerCount && !customerCount && (!savedSearch || populateList)) {
            alert('You must select at least one recipient in the tabs below!');
            return false;
        }
        return true;
    }
    function fillListFromSearch(searchType, searchId, rec) {
        // const columns = ['email', 'isinactive'];
        // if (searchType == 'contact') columns.push('company'); // TODO: Do we need this?
        search.load.promise({ id: searchId }).then((entitySearch) => {
            entitySearch.run().getRange.promise({ start: 0, end: 1000 }).then(async (results) => {
                console.log('Search', searchId, 'results', results.length);
                if (results.length == 1000) { // Warn them that they're not getting all the results
                    const decision = await dialog.confirm({
                        title: 'Very Large Search Result Set',
                        message: 'With the populate sublist checkbox enabled, only the first 1000 search results will be processed. Loading 1000 sublist lines may take several minutes and cause your browser to become unresponsive. Are you sure you want to populate the results in the sublist? If you click cancel then all results will be processed server-side when you click the Send button.'
                    });
                    if (!decision)
                        return rec.setValue('custpage_populate_list', false);
                }
                else if (results.length > 100) { // Warn them that this will take a minute
                    dialog.alert({ title: 'Large Search Result Set', message: `Your search returned ${results.length} results - this may take a few minutes to populate in the sublist.` });
                }
                const sublistId = `custpage_${searchType}s`;
                for (const result of results) {
                    const emailAddress = result.getValue('email');
                    const inactive = result.getValue('isinactive');
                    if (!emailAddress || inactive)
                        continue;
                    rec.selectNewLine({ sublistId });
                    rec.setCurrentSublistValue({ sublistId, fieldId: `custpage_${searchType}_${searchType}`, value: result.id, ignoreFieldChange: true });
                    rec.setCurrentSublistValue({ sublistId, fieldId: `custpage_${searchType}_email`, value: emailAddress, ignoreFieldChange: true });
                    if (searchType == 'contact') {
                        const companyName = result.getText('company');
                        rec.setCurrentSublistValue({ sublistId, fieldId: `custpage_contact_company`, value: companyName, ignoreFieldChange: true });
                    }
                    rec.commitLine({ sublistId });
                }
            }).catch((reason) => {
                alert(`Failed to run saved search: ${reason}`);
            });
        }).catch((reason) => {
            alert(`Failed to load saved search: ${reason}`);
        });
    }
    function setTemplatePreviewContent(rec, templateId) {
        if (templateId) { // Load the template and set the subject and body fields from the content (not a merge, just the preview)
            const banner = message.create({ type: message.Type.INFORMATION, title: 'Loading...', message: `Loading template preview...` });
            record.load.promise({ type: 'emailtemplate', id: templateId }).then((templateRec) => {
                rec.setValue('custpage_subject', templateRec.getValue('subject'));
                rec.setValue('custpage_body', templateRec.getValue('content') || 'Email template file will be used.');
                rec.getField({ fieldId: 'custpage_subject' }).isDisabled = true;
                rec.getField({ fieldId: 'custpage_body' }).isDisabled = true;
                banner.hide();
            }).catch((reason) => {
                console.log('Failed to load email template', templateId, 're-trying as campaign template.', reason.message);
                alert('Failed to load the template you selected, please ensure you select an Email Template and not a Campaign Template');
                rec.setValue('custpage_template', '');
            });
            banner.show();
        }
        else {
            rec.getField({ fieldId: 'custpage_subject' }).isDisabled = false;
            rec.getField({ fieldId: 'custpage_body' }).isDisabled = false;
            rec.setValue('custpage_subject', '');
            rec.setValue('custpage_body', '');
        }
    }
});
