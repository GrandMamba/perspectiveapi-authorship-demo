/*
Copyright 2017 Google Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { Injectable } from '@angular/core';
import { PerspectiveStatus, CommentFeedback } from './perspective-status.component';
import { PerspectiveApiService } from './perspectiveapi.service';
import {
  AnalyzeCommentResponse,
  SpanScores,
  SuggestCommentScoreResponse,
} from './perspectiveapi-types'
import { sha256 } from 'js-sha256';
import { Subscription } from 'rxjs/Subscription';

// Import RxJs required methods
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/catch';
import 'rxjs/add/operator/finally';

export interface InputEvent {
  target: HTMLInputElement;
}

export interface DemoSettings {
  configuration: string;
  gradientColors: string[];
  apiKey: string;
  useGapi: boolean;
  showPercentage: boolean;
  showMoreInfoLink: boolean;
  feedbackText: [string, string, string];
  scoreThresholds: [number, number, number];
}

@Component({
  selector: 'convai-checker',
  templateUrl: './convai-checker.component.html',
  styleUrls: ['./convai-checker.component.css'],
  providers: [PerspectiveApiService],
  // Allows listening to input events outside of this component.
  host: {
    '(document:input)': '_handleInputEvent($event)',
  },
})
export class ConvaiChecker implements OnInit, OnChanges {
  @ViewChild(PerspectiveStatus) statusWidget: PerspectiveStatus;
  @Input() inputId: string;
  @Input() serverUrl: string;
  @Input() fontSize: number = 12;
  @Input() demoSettings: DemoSettings;
  @Output() scoreChangeAnimationCompleted: EventEmitter<void> = new EventEmitter<void>();
  @Output() modelInfoLinkClicked: EventEmitter<void> = new EventEmitter<void>();
  @Output() analyzeCommentResponseChanged: EventEmitter<AnalyzeCommentResponse|null> =
    new EventEmitter<AnalyzeCommentResponse|null>();
  analyzeCommentResponse: AnalyzeCommentResponse|null = null;
  private checkInProgress: boolean;
  private mostRecentRequestSubscription: Subscription;
  // Number is the return type of window.setTimeout(), which is used to update
  // the pending request when the user is continuously typing, to not send too
  // many requests that will be ignored.
  private pendingRequest: number;
  private lastRequestedText: string;
  private lastPendingRequestedText: string;
  private inputListener: EventListener;
  public initializeErrorMessage: string;
  public analyzeErrorMessage: string|null = null;
  public canAcceptFeedback: boolean = false;
  public feedbackRequestInProgress: boolean = false;
  private sessionId: string|null = null;
  private gradientColors: string[] = ["#25C1F9", "#7C4DFF", "#D400F9"];
  private apiKey: string = '';
  private configuration: string;

  constructor(
      private elementRef: ElementRef,
      private analyzeApiService: PerspectiveApiService,
  ) {
    // Extracts attribute fields from the element declaration. This
    // covers the case where this component is used as a root level
    // component outside an angular component tree and we cannot get
    // these values from data bindings.
    this.inputId = this.elementRef.nativeElement.getAttribute('inputId');

    // Default to '' to use same server as whatever's serving the webapp.
    this.serverUrl =
      this.elementRef.nativeElement.getAttribute('serverUrl') || '';
  };

  ngOnInit() {
    if (this.inputId === undefined) {
      this.initializeErrorMessage = "Error initializing: No input element id"
        + " specified. Set inputId=<inputElementId> to use this component.";
      return;
    }

    if (this.apiKey) {
      this.analyzeApiService.initGapiClient(this.apiKey);
    }

    this.sessionId = window.localStorage.getItem(LOCAL_STORAGE_SESSION_ID_KEY);
    if (this.sessionId === null) {
      this.sessionId = Math.round(Date.now() * Math.random()).toString();
      window.localStorage.setItem(LOCAL_STORAGE_SESSION_ID_KEY, this.sessionId);
    }
  }

  ngOnChanges(changes: SimpleChanges) : void {
    if (changes['demoSettings']) {
      if (this.demoSettings && this.apiKey !== this.demoSettings.apiKey) {
        console.log('Api key changes detected in demoSettings', changes);
        this.apiKey = this.demoSettings.apiKey;
        this.analyzeApiService.initGapiClient(this.apiKey);
      }
    }
  }

  // Public interface for manually checking text and updating the UI.
  // Note that this does NOT change the contents of the text box. This
  // is intended to be used for handling programmatic changes to the
  // input box not caused by a user typing.
  public checkText(text: string) {
    this._handlePendingCheckRequest(text);
  }

  // Listens to input events from elements outside the component, and forwards
  // the ones from the element with the desired input id into our check request
  // handlers.
  // TODO(rachelrosen): Consider using a CSS selector for this instead, for
  // better specificity.
  private _handleInputEvent(event: InputEvent) {
    if (event.target.id === this.inputId) {
      this._handlePendingCheckRequest(event.target.value);
    }
  }

  private _handlePendingCheckRequest(text: string) {
    // Don't make duplicate requests.
    if (text === this.lastRequestedText ||
        text === this.lastPendingRequestedText) {
      console.debug('Duplicate request text ' + text + '; returning');
      return;
    }

    // Clear any pending requests since data has changed.
    console.debug('Clearing this.pendingRequest');
    clearTimeout(this.pendingRequest);
    this.analyzeErrorMessage = null;

    // Text has been cleared, return to default state.
    if (!text) {
      this.analyzeCommentResponse = null;
      this.analyzeCommentResponseChanged.emit(this.analyzeCommentResponse);
      this.statusWidget.setLoading(false);
      this.canAcceptFeedback = false;
      this.statusWidget.resetFeedback();
      return;
    }

    this.lastPendingRequestedText = text;
    this.statusWidget.setLoading(true);

    // Use window.setTimeout() instead of just setTimeout() because
    // Typescript gets confused about the typings when compiling for
    // a development environment vs a testing environment (the former sees
    // NodeJS.Timer while the latter sees number). Using window.setTimeout
    // makes it consistently type number.
    console.debug('Updating this.pendingRequest');
    this.pendingRequest = window.setTimeout(() => {
      this._checkText(text);
    }, REQUEST_LIMIT_MS);

  }

  onCommentFeedbackReceived(feedback: CommentFeedback) {
    if (this.analyzeCommentResponse === null) {
      // Don't send feedback for an empty input box.
      return;
    }

    this.suggestCommentScore(this.lastRequestedText, feedback);
  }

  handleScoreChangeAnimationCompleted() {
    // Allow the output event to bubble up from the child checker-status
    // component through this component.
    this.scoreChangeAnimationCompleted.emit();
    console.debug('Score animation completed! Emitting an event');
  }

  handleModelInfoLinkClicked() {
    // Allow the output event to bubble up from the child checker-status
    // component through this component.
    this.modelInfoLinkClicked.emit();
  }

  suggestCommentScore(text: string, feedback: CommentFeedback): void {
    this.feedbackRequestInProgress = true;
    this.analyzeApiService.suggestScore(
      text,
      this.sessionId,
      feedback.commentMarkedAsToxic,
      this.demoSettings.useGapi /* makeDirectApiCall */,
      this.serverUrl
    ).finally(() => {
        console.debug('Feedback request done');
        this.statusWidget.hideFeedbackQuestion();
        this.feedbackRequestInProgress = false;
      })
      .subscribe(
        (response: SuggestCommentScoreResponse) => {
          this.statusWidget.feedbackCompleted(true);
          console.log(response);
        },
        (error: Error) => {
          console.error('Error', error);
          this.statusWidget.feedbackCompleted(false);
        }
      );
  }

  private _getErrorMessage(error: any): string {
    let msg = 'Error scoring text. Please try again.';
    // Look at detailed API error messages for more meaningful error to return.
    try {
      for (const api_err of error.json().errors) {
        // TODO(jetpack): a small hack to handle the language detection failure
        // case. we should instead change the API to return documented, typeful
        // errors.
        if (api_err.message.includes('does not support request languages')) {
          msg = 'Sorry! Perspective needs more training data to work in this '
            + 'language.';
          break;
        }
      }
    } catch (e) {
      console.warn('Failed to parse error. ', e);
    }
    return msg;
  }

  private _checkText(text: string) {
    // Cancel listening to callbacks of previous requests.
    if (this.mostRecentRequestSubscription) {
      this.mostRecentRequestSubscription.unsubscribe();
    }

    this.statusWidget.resetFeedback();

    console.log('Checking text ' + text);

    this.lastRequestedText = text;
    this.checkInProgress = true;

    this.mostRecentRequestSubscription =
      this.analyzeApiService.checkText(
          text,
          this.sessionId,
          this.demoSettings.useGapi /* makeDirectApiCall */,
          this.serverUrl)
        .finally(() => {
          console.debug('Request done');
          this.statusWidget.setLoading(this.checkInProgress);
          this.mostRecentRequestSubscription = null;
        })
        .subscribe(
          (response: AnalyzeCommentResponse) => {
            this.analyzeCommentResponse = response;
            this.analyzeCommentResponseChanged.emit(this.analyzeCommentResponse);
            console.log(this.analyzeCommentResponse);
            this.checkInProgress = false;
            this.canAcceptFeedback = true;
          },
          (error) => {
            console.error('Error', error);
            this.checkInProgress = false;
            this.canAcceptFeedback = false;
            this.analyzeErrorMessage = this._getErrorMessage(error);
            this.analyzeCommentResponse = null;
          }
        );
  }

  getToken(text: string): string {
    return sha256(text);
  }

  getMaxScore(response: AnalyzeCommentResponse): number {
    if (response === null || response.attributeScores == null) {
      return 0;
    }
    let max: number = undefined;
    Object.keys(response.attributeScores).forEach((key: string) => {
      let maxSpanScoreForAttribute =
        this.getMaxSpanScore(response.attributeScores[key]);
      if (max === undefined || maxSpanScoreForAttribute > max) {
          max = maxSpanScoreForAttribute;
      }
    });

    if (max === undefined) {
      console.error('No "value" field found for score. Returning 0.');
      max = 0;
    }
    return max;
  }

  getMaxSpanScore(spanScores: SpanScores): number {
    let max: number = undefined;
    for (let spanScore of spanScores.spanScores) {
      if (max === undefined || spanScore.score.value > max) {
        max = spanScore.score.value;
      }
    }
    return max;
  };
}

const REQUEST_LIMIT_MS = 500;
const LOCAL_STORAGE_SESSION_ID_KEY = 'sessionId';
