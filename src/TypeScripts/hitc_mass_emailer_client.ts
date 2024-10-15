/**
 * hitc_mass_emailer_client.ts
 * by Head in the Cloud Development, Inc.
 * gurus@headintheclouddev.com
 *
 * @NScriptType ClientScript
 * @NApiVersion 2.1
 */

import {EntryPoints} from "N/types";
import dialog  = require('N/ui/dialog');
import message = require('N/ui/message');
import record  = require('N/record');
import search  = require('N/search');

export function pageInit(context: EntryPoints.Client.pageInitContext) { // [HITC-135] SSv2 conversion
  const transactionParameter = getParameter('transaction'); // This isn't currently in use. Can be hooked up to a button on transactions.
  if (transactionParameter) context.currentRecord.setValue('custpage_transaction', transactionParameter);
}

export function fieldChanged(context: EntryPoints.Client.fieldChangedContext) {
  console.log('Field Changed', context.sublistId, context.fieldId);
  const subject     = context.currentRecord.getValue('custpage_subject')     as string;
  const template    = context.currentRecord.getValue('custpage_template')    as string;
  const transaction = context.currentRecord.getValue('custpage_transaction') as string;
  const transText   = context.currentRecord.getText('custpage_transaction')  as string;
  if (context.fieldId == 'custpage_contact_contact') { // Source in company name & email
    const contact = context.currentRecord.getCurrentSublistValue({ sublistId: 'custpage_contacts', fieldId: 'custpage_contact_contact' }) as string;
    if (contact) search.lookupFields.promise({ type: 'contact', id: contact, columns: ['company', 'email'] }).then((contactValues) => {
      console.log('Contact values', contactValues);
      const companies    = contactValues['company'] as { value: string, text: string }[];
      const companyName  = (companies && companies.length > 0) ? companies[0].text : '';
      const emailAddress = contactValues.email as string;
      context.currentRecord.setCurrentSublistValue({ sublistId: 'custpage_contacts', fieldId: 'custpage_contact_company', value: companyName  });
      context.currentRecord.setCurrentSublistValue({ sublistId: 'custpage_contacts', fieldId: 'custpage_contact_email',   value: emailAddress });
    }).then((err) => {
      console.log('fieldChanged error', err);
    });
  } else if (['custpage_employee_employee', 'custpage_partner_partner', 'custpage_customer_customer'].includes(context.fieldId)) { // Source in email
    const entityId = context.currentRecord.getCurrentSublistValue({ sublistId: context.sublistId, fieldId: context.fieldId }) as string;
    if (entityId) search.lookupFields.promise({ type: 'entity', id: entityId, columns: ['email', 'type'] }).then((entityValues) => {
      console.log('Entity values', entityValues);
      const entityTypes = entityValues['type'] as { value: string, text: string }[]; // May be like: [{ value: 'CustJob', text: 'Customer' }]
      const fieldId     = `custpage_${entityTypes[0].text.toLowerCase()}_email`;
      context.currentRecord.setCurrentSublistValue({ sublistId: context.sublistId, fieldId, value: entityValues.email as string });
    });
  } else if (context.fieldId == 'custpage_transaction' && !subject && transaction && !template) {
    context.currentRecord.setValue('custpage_subject', transText);
  } else if (context.fieldId == 'custpage_template') {
    setTemplatePreviewContent(context.currentRecord, template);
  } else if (['custpage_search_type', 'custpage_populate_list'].includes(context.fieldId)) {
    const searchId     = context.currentRecord.getValue('custpage_saved_search')  as string;
    const populateList = context.currentRecord.getValue('custpage_populate_list') as boolean;
    const searchType   = context.currentRecord.getValue('custpage_search_type')   as string;
    if (searchId && searchType && populateList) fillListFromSearch(searchType, searchId, context.currentRecord)
  } else if (context.fieldId == 'custpage_saved_search') {
    const searchId = context.currentRecord.getValue('custpage_saved_search') as string;
    if (searchId) {
      search.load.promise({ id: searchId }).then((savedSearch) => {
        context.currentRecord.setValue({ fieldId: 'custpage_search_type', value: savedSearch.searchType })
      });
    }
  }
}

export function saveRecord(context: EntryPoints.Client.saveRecordContext): boolean {
  // Require template OR subject and body
  const template = context.currentRecord.getValue('custpage_template');
  const subject  = context.currentRecord.getValue('custpage_subject');
  const body     = context.currentRecord.getValue('custpage_body');

  if (!template && (!subject && body)) {
    alert('You must either select a Template or enter an email subject and body');
    return false;
  }

  // Require at least one recipient
  const contactCount  = context.currentRecord.getLineCount({ sublistId: 'custpage_contacts'  });
  const employeeCount = context.currentRecord.getLineCount({ sublistId: 'custpage_employees' });
  const customerCount = context.currentRecord.getLineCount({ sublistId: 'custpage_customers' });
  const partnerCount  = context.currentRecord.getLineCount({ sublistId: 'custpage_partners'  });
  const populateList  = context.currentRecord.getValue('custpage_populate_list') as boolean;
  const savedSearch   = context.currentRecord.getValue('custpage_saved_search')  as string;

  if (!contactCount && !employeeCount && !partnerCount && !customerCount && (!savedSearch || populateList)) {
    alert('You must select at least one recipient in the tabs below!');
    return false;
  }

  return true;
}

function fillListFromSearch(searchType: string, searchId: string, rec: record.ClientCurrentRecord): void {
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
        if (!decision) return rec.setValue('custpage_populate_list', false);
      } else if (results.length > 100) { // Warn them that this will take a minute
        dialog.alert({ title: 'Large Search Result Set', message: `Your search returned ${results.length} results - this may take a few minutes to populate in the sublist.` });
      }
      const sublistId = `custpage_${searchType}s`;
      for (const result of results) {
        const emailAddress = result.getValue('email');
        const inactive     = result.getValue('isinactive');
        if (!emailAddress || inactive) continue;
        rec.selectNewLine({ sublistId });
        rec.setCurrentSublistValue({ sublistId, fieldId: `custpage_${searchType}_${searchType}`, value: result.id,    ignoreFieldChange: true });
        rec.setCurrentSublistValue({ sublistId, fieldId: `custpage_${searchType}_email`,         value: emailAddress, ignoreFieldChange: true });
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

function setTemplatePreviewContent(rec: record.ClientCurrentRecord, templateId: string): void {
  if (templateId) { // Load the template and set the subject and body fields from the content (not a merge, just the preview)
    const banner = message.create({ type: message.Type.INFORMATION, title: 'Loading...', message: `Loading template preview...` });
    record.load.promise({ type: 'emailtemplate', id: templateId }).then((templateRec) => {
      rec.setValue('custpage_subject', templateRec.getValue('subject'));
      rec.setValue('custpage_body', templateRec.getValue('content') || 'Email template file will be used.');
      rec.getField({ fieldId: 'custpage_subject' }).isDisabled = true;
      rec.getField({ fieldId: 'custpage_body'    }).isDisabled = true;
      banner.hide();
    }).catch((reason) => {
      console.log('Failed to load email template', templateId, 're-trying as campaign template.', reason.message);
      alert('Failed to load the template you selected, please ensure you select an Email Template and not a Campaign Template');
      rec.setValue('custpage_template', '');
    });
    banner.show();
  } else {
    rec.getField({ fieldId: 'custpage_subject' }).isDisabled = false;
    rec.getField({ fieldId: 'custpage_body'    }).isDisabled = false;
    rec.setValue('custpage_subject', '');
    rec.setValue('custpage_body', '');
  }
}

declare function getParameter(name: string): string;
