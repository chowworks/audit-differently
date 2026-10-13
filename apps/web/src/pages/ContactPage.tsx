import { useSearchParams } from 'react-router-dom'
import {
  CONTACT_PAGE_MAX,
  CONTACT_PAGE_PATTERN,
  CONTACT_TOPICS,
  type ContactTopic,
} from '@ad/types'
import { ContactForm } from '@/components/ContactForm'

const DEMO_MESSAGE = "I'm excited to learn more about Audit Differently."

/** `?topic=` as one of CONTACT_TOPICS (`?demo` is the demo topic); anything else is a general question. */
function topicFrom(params: URLSearchParams): ContactTopic {
  if (params.has('demo')) return 'demo'
  const topic = params.get('topic')
  return CONTACT_TOPICS.find((t) => t === topic) ?? 'question'
}

/** `?page=` when it is a plain path the API will accept (never a query string or hash), else nothing. */
function pageFrom(params: URLSearchParams): string | undefined {
  const page = params.get('page')
  return page && page.length <= CONTACT_PAGE_MAX && CONTACT_PAGE_PATTERN.test(page)
    ? page
    : undefined
}

/**
 * The public contact page, signed in or out (App.tsx routes it in both trees). `?topic=` prefills the topic,
 * and `?page=` names the address a broken-link report is about (the 404 page sends both). /contact?demo, or
 * ?topic=demo, opens it as a demo request, with the message already filled in.
 */
export function ContactPage() {
  const [params] = useSearchParams()
  const topic = topicFrom(params)
  const demo = topic === 'demo'
  return (
    <div className="mx-auto max-w-2xl">
      <div className="ad-head">
        <div>
          <h1 className="ad-h1">{demo ? 'Book a demo' : 'Contact us'}</h1>
          <p className="ad-sub">
            {demo
              ? 'Tell us a little about your team and we will set up a time to walk you through it.'
              : 'Questions about Audit Differently, a demo for your team, or anything else: write here and we will answer by email.'}
          </p>
        </div>
      </div>
      <ContactForm
        initialMessage={demo ? DEMO_MESSAGE : ''}
        initialCategory={topic}
        page={pageFrom(params)}
      />
    </div>
  )
}
