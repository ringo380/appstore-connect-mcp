import { AppStoreClient } from '../api/client.js';

export interface CustomerReview {
  id: string;
  rating: number;
  title?: string;
  body?: string;
  reviewerNickname?: string;
  createdDate: string;
  territory?: string;
  appVersionString?: string;
}

export interface ReviewResponse {
  id: string;
  responseBody: string;
  lastModifiedDate: string;
  state: 'PUBLISHED' | 'PENDING_PUBLISH' | 'DRAFT';
}

export interface ReviewMetrics {
  averageRating: number;
  totalRatings: number;
  ratingDistribution: {
    oneStar: number;
    twoStar: number;
    threeStar: number;
    fourStar: number;
    fiveStar: number;
  };
  recentReviews: CustomerReview[];
  topPositiveReviews: CustomerReview[];
  topCriticalReviews: CustomerReview[];
  responseRate: number;
}

export class ReviewService {
  constructor(private client: AppStoreClient) {}

  /**
   * Get customer reviews for an app
   */
  async getCustomerReviews(appId: string, limit: number = 100): Promise<CustomerReview[]> {
    try {
      const response = await this.client.request(`/apps/${appId}/customerReviews`, {
        limit,
        sort: '-createdDate',
        include: 'response'
      });
      
      if (response.data) {
        return this.formatCustomerReviews(response.data);
      }
      
      return [];
    } catch (error) {
      // Try alternative endpoint
      const response2 = await this.client.request('/customerReviews', {
        'filter[app]': appId,
        limit,
        sort: '-createdDate'
      });
      if (response2.data) return this.formatCustomerReviews(response2.data);
      return [];
    }
  }

  /**
   * Get review responses
   */
  async getReviewResponses(appId: string): Promise<ReviewResponse[]> {
    try {
      const response = await this.client.request('/customerReviewResponses', {
        'filter[customerReview.app]': appId,
        limit: 100
      });
      
      if (response.data) {
        return this.formatReviewResponses(response.data);
      }
      
      return [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Get app ratings summary
   */
  async getRatingSummary(appId: string): Promise<any> {
    try {
      const response = await this.client.request(`/apps/${appId}/appStoreVersions`, {
        limit: 1,
        include: 'appStoreReviewDetail'
      });
      
      if (response.data && response.data[0]) {
        const version = response.data[0];
        return {
          averageRating: version.attributes?.averageRating || 0,
          totalRatings: version.attributes?.totalRatingCount || 0,
          currentVersionRating: version.attributes?.currentVersionRating || 0,
          currentVersionRatingCount: version.attributes?.currentVersionRatingCount || 0
        };
      }
      
      return {
        averageRating: 0,
        totalRatings: 0
      };
    } catch {
      return { averageRating: 0, totalRatings: 0 };
    }
  }

  /**
   * Get comprehensive review metrics
   */
  async getReviewMetrics(appId: string): Promise<ReviewMetrics> {
    // Fetch data in parallel
    const [reviews, responses, summary] = await Promise.all([
      this.getCustomerReviews(appId, 200),
      this.getReviewResponses(appId),
      this.getRatingSummary(appId)
    ]);

      // Calculate rating distribution
      const distribution = {
        oneStar: 0,
        twoStar: 0,
        threeStar: 0,
        fourStar: 0,
        fiveStar: 0
      };

      reviews.forEach(review => {
        switch (review.rating) {
          case 1:
            distribution.oneStar++;
            break;
          case 2:
            distribution.twoStar++;
            break;
          case 3:
            distribution.threeStar++;
            break;
          case 4:
            distribution.fourStar++;
            break;
          case 5:
            distribution.fiveStar++;
            break;
        }
      });

      // Sort reviews by rating for top/bottom lists
      const sortedByRating = [...reviews].sort((a, b) => b.rating - a.rating);
      const positiveReviews = sortedByRating.filter(r => r.rating >= 4).slice(0, 5);
      const criticalReviews = sortedByRating.filter(r => r.rating <= 2).slice(0, 5);

      // Calculate response rate
      const reviewsWithResponses = responses.filter(r => r.state === 'PUBLISHED').length;
      const responseRate = reviews.length > 0 
        ? (reviewsWithResponses / reviews.length) * 100 
        : 0;

      return {
        averageRating: summary.averageRating || this.calculateAverageRating(reviews),
        totalRatings: summary.totalRatings || reviews.length,
        ratingDistribution: distribution,
        recentReviews: reviews.slice(0, 10),
        topPositiveReviews: positiveReviews,
        topCriticalReviews: criticalReviews,
        responseRate: Math.round(responseRate)
      };
  }

  /**
   * Get sentiment analysis of reviews
   */
  async getReviewSentiment(appId: string): Promise<any> {
    const reviews = await this.getCustomerReviews(appId, 100);
    
    // Basic sentiment analysis based on ratings and keywords
    const sentiments = {
      positive: 0,
      neutral: 0,
      negative: 0,
      topics: new Map<string, number>()
    };

    const positiveWords = ['love', 'great', 'excellent', 'amazing', 'perfect', 'best', 'awesome'];
    const negativeWords = ['hate', 'terrible', 'worst', 'awful', 'horrible', 'bad', 'crash'];
    const topics = ['ui', 'performance', 'feature', 'bug', 'price', 'update', 'design'];

    reviews.forEach(review => {
      // Categorize by rating
      if (review.rating >= 4) {
        sentiments.positive++;
      } else if (review.rating === 3) {
        sentiments.neutral++;
      } else {
        sentiments.negative++;
      }

      // Extract topics from review text
      const text = `${review.title || ''} ${review.body || ''}`.toLowerCase();
      
      topics.forEach(topic => {
        if (text.includes(topic)) {
          sentiments.topics.set(topic, (sentiments.topics.get(topic) || 0) + 1);
        }
      });
    });

    // Convert topics map to array
    const topTopics = Array.from(sentiments.topics.entries())
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      summary: 'Review Sentiment Analysis',
      distribution: {
        positive: sentiments.positive,
        neutral: sentiments.neutral,
        negative: sentiments.negative
      },
      percentages: {
        positive: reviews.length > 0 ? Math.round((sentiments.positive / reviews.length) * 100) : 0,
        neutral: reviews.length > 0 ? Math.round((sentiments.neutral / reviews.length) * 100) : 0,
        negative: reviews.length > 0 ? Math.round((sentiments.negative / reviews.length) * 100) : 0
      },
      topTopics,
      sampleSize: reviews.length
    };
  }

  /**
   * Format customer reviews
   */
  private formatCustomerReviews(rawData: any[]): CustomerReview[] {
    return rawData.map(review => ({
      id: review.id,
      rating: review.attributes?.rating || 0,
      title: review.attributes?.title,
      body: review.attributes?.body,
      reviewerNickname: review.attributes?.reviewerNickname || 'Anonymous',
      createdDate: review.attributes?.createdDate || new Date().toISOString(),
      territory: review.attributes?.territory,
      appVersionString: review.attributes?.appVersionString
    }));
  }

  /**
   * Format review responses
   */
  private formatReviewResponses(rawData: any[]): ReviewResponse[] {
    return rawData.map(response => ({
      id: response.id,
      responseBody: response.attributes?.responseBody || '',
      lastModifiedDate: response.attributes?.lastModifiedDate || new Date().toISOString(),
      state: response.attributes?.state || 'DRAFT'
    }));
  }

  /**
   * Calculate average rating from reviews
   */
  private calculateAverageRating(reviews: CustomerReview[]): number {
    if (reviews.length === 0) return 0;
    
    const sum = reviews.reduce((acc, review) => acc + review.rating, 0);
    return Math.round((sum / reviews.length) * 10) / 10;
  }

  /**
   * Get comprehensive review summary
   */
  async getReviewSummary(appId: string): Promise<any> {
    const [metrics, sentiment] = await Promise.all([
      this.getReviewMetrics(appId),
      this.getReviewSentiment(appId)
    ]);

    return {
      summary: 'Customer Reviews and Ratings Summary',
      rating: {
        average: metrics.averageRating,
        total: metrics.totalRatings,
        distribution: metrics.ratingDistribution
      },
      sentiment: sentiment.percentages,
      topIssues: sentiment.topTopics.filter((t: any) => 
        ['bug', 'crash', 'problem'].includes(t.topic)
      ),
      highlights: {
        mostLovedFeatures: sentiment.topTopics.filter((t: any) => 
          ['feature', 'design', 'ui'].includes(t.topic)
        ),
        responseRate: `${metrics.responseRate}%`,
        recentReviewsCount: metrics.recentReviews.length
      },
      recommendations: this.generateRecommendations(metrics, sentiment),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Generate recommendations based on review analysis
   */
  private generateRecommendations(metrics: ReviewMetrics, sentiment: any): string[] {
    const recommendations = [];

    if (metrics.responseRate < 50) {
      recommendations.push('Increase developer response rate to customer reviews');
    }

    if (sentiment.percentages.negative > 30) {
      recommendations.push('Address critical issues mentioned in negative reviews');
    }

    if (metrics.ratingDistribution.oneStar + metrics.ratingDistribution.twoStar > 
        metrics.totalRatings * 0.2) {
      recommendations.push('Focus on improving user experience for dissatisfied users');
    }

    if (metrics.averageRating < 4.0) {
      recommendations.push('Implement user feedback to improve overall rating');
    }

    return recommendations;
  }
}