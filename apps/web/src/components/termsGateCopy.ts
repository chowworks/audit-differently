/** What the Terms screen says: a returning person is told the Terms were updated, a new one is just asked. */
export function termsGateCopy(previouslyAccepted: boolean) {
  return previouslyAccepted
    ? {
        heading: 'Our Terms & Conditions have been updated',
        intro: 'Please read the updated Terms & Conditions and accept them to continue.',
      }
    : {
        heading: 'Terms & Conditions',
        intro: 'Please read and accept the Terms & Conditions to continue.',
      }
}
